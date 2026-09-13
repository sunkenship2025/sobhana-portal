/**
 * /api/automations — the Admin → Automations section.
 *
 * Owner-only, matching the existing Config Center gate. The split that will matter
 * when access widens is AUTHOR vs ACTIVATE, not per-screen CRUD: editing a draft is
 * ordinary work, and turning on something that messages two thousand people is not.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import { logAction } from '../services/auditService';
import prisma from '../lib/prisma';
import {
  listAutomations, automationResults, activity, runDetail, patientAutomations,
} from '../services/automations/queries';
import { dryRun, simulate } from '../services/automations/preview';
import { unknownPredicates, PREDICATE_CATALOG } from '../services/automations/predicates';
import { listBlueprints, buildFromBlueprint } from '../services/automations/blueprints';
import { STEP_CATALOG, validateDefinition } from '../services/automations/steps';
import { listMessageTemplates } from '../services/whatsappCloudService';
import type { AutomationDefinition } from '../services/automations/types';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

const fail = (res: any, e: unknown, code = 500) =>
  res.status(code).json({ error: (e as Error).message ?? 'FAILED' });

router.get('/', async (_req: AuthRequest, res) => {
  try { return res.json({ automations: await listAutomations() }); }
  catch (e) { return fail(res, e); }
});

router.get('/templates', async (_req: AuthRequest, res) => {
  try { return res.json({ templates: await listMessageTemplates() }); }
  catch (e) { return fail(res, e); }
});

/**
 * The engine's grammar. Served so the builder can compare what it renders against what
 * the engine runs, and say so when it falls behind rather than hiding a step.
 */
router.get('/steps', async (_req: AuthRequest, res) => {
  try { return res.json({ steps: STEP_CATALOG }); }
  catch (e) { return fail(res, e); }
});

/** Read a definition back and say what is wrong with it, before it can be saved. */
router.post('/validate', async (req: AuthRequest, res) => {
  try { return res.json({ problems: validateDefinition(req.body?.definition ?? {}) }); }
  catch (e) { return fail(res, e); }
});

/** What an automation can BE. Served, so a new kind is a backend entry, not a React edit. */
router.get('/blueprints', async (_req: AuthRequest, res) => {
  try { return res.json({ blueprints: listBlueprints() }); }
  catch (e) { return fail(res, e); }
});

/**
 * Create from a blueprint. The browser sends the ANSWERS; the definition is assembled
 * here, so the shape of a definition is known in exactly one place.
 */
router.post('/from-blueprint', async (req: AuthRequest, res) => {
  try {
    const { blueprintId, name, values } = req.body ?? {};
    if (!blueprintId) return res.status(400).json({ error: 'BLUEPRINT_REQUIRED' });

    const built = buildFromBlueprint(blueprintId, values ?? {});
    if (!built) return res.status(400).json({ error: `UNKNOWN_BLUEPRINT: ${blueprintId}` });

    const missing = built.blueprint.fields
      .filter((f) => f.required)
      .filter((f) => {
        const v = (values ?? {})[f.key];
        return v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
      })
      .map((f) => f.label);
    if (missing.length) {
      return res.status(400).json({ error: `MISSING: ${missing.join(', ')}` });
    }

    const branchIds = Array.isArray(values?.branchIds) ? (values.branchIds as string[]) : [];

    const a = await prisma.automation.create({
      data: {
        key: `${blueprintId}_${Date.now().toString(36).toUpperCase()}`,
        name: (name as string)?.trim() || built.blueprint.title,
        group: built.blueprint.group,
        definition: built.definition as object,
        // Disabled, no watermark. Creating is not activating.
        enabled: false,
        activatedAt: null,
        holdoutPct: built.blueprint.holdoutPct,
        priority: 3,
        branchIds,
      },
    });
    await logAction({
      branchId: req.branchId!, actionType: 'CREATE', entityType: 'Automation',
      entityId: a.id, userId: req.user?.id, newValues: JSON.stringify({ blueprintId, name: a.name }),
    });
    return res.status(201).json(a);
  } catch (e) { return fail(res, e); }
});

/**
 * Who could receive a report. Anyone active with a phone number in Roles — not only
 * owners, because "the practice manager should get the OP sheet too" should not need a
 * developer.
 */
router.get('/recipients', async (_req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true, phone: { not: null } },
      select: { id: true, name: true, role: true, phone: true },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    return res.json({
      recipients: users.map((u) => ({
        ...u,
        // Masked: this list exists to choose from, not to publish staff numbers.
        phone: u.phone ? `${u.phone.slice(0, 2)}xxxxx${u.phone.slice(-3)}` : null,
      })),
    });
  } catch (e) { return fail(res, e); }
});

/** What the condition builder may offer. Served, never hardcoded in the frontend. */
router.get('/predicates', async (_req: AuthRequest, res) => {
  try { return res.json({ predicates: PREDICATE_CATALOG }); }
  catch (e) { return fail(res, e); }
});

router.get('/activity', async (req: AuthRequest, res) => {
  try {
    return res.json(
      await activity({
        automationId: req.query.automationId as string | undefined,
        outcome: req.query.outcome as string | undefined,
        patientId: req.query.patientId as string | undefined,
        branchId: req.query.branchId as string | undefined,
        days: req.query.days ? Number(req.query.days) : undefined,
        cursor: req.query.cursor as string | undefined,
        take: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    );
  } catch (e) { return fail(res, e); }
});

/** The distinct reason codes actually present, so the Why filter is never a guess. */
router.get('/activity/reasons', async (_req: AuthRequest, res) => {
  try {
    const rows = await prisma.automationStepLog.groupBy({
      by: ['outcome'],
      _count: { _all: true },
      orderBy: { _count: { outcome: 'desc' } },
    });
    return res.json({ reasons: rows.map((r) => ({ outcome: r.outcome, count: r._count._all })) });
  } catch (e) { return fail(res, e); }
});

router.get('/runs/:runId', async (req: AuthRequest, res) => {
  try {
    const run = await runDetail(req.params.runId);
    return run ? res.json(run) : res.status(404).json({ error: 'NOT_FOUND' });
  } catch (e) { return fail(res, e); }
});

/**
 * Stop ONE patient's journey. Deliberately a different endpoint from pausing the
 * automation: the two are one careless click apart and three thousand patients
 * different, so they are not the same verb on the same object.
 */
router.post('/runs/:runId/stop', async (req: AuthRequest, res) => {
  try {
    const updated = await prisma.automationRun.updateMany({
      where: { id: req.params.runId, state: { in: ['PENDING', 'RUNNING'] } },
      data: { state: 'STOPPED', stopReason: 'STOPPED_BY_STAFF', nextActionAt: null },
    });
    if (updated.count === 1) {
      await prisma.automationStepLog.create({
        data: { runId: req.params.runId, stepIndex: 0, kind: 'STOPPED', outcome: 'STOPPED_BY_STAFF' },
      });
    }
    return res.json({ stopped: updated.count === 1 });
  } catch (e) { return fail(res, e); }
});

router.get('/patients/:patientId', async (req: AuthRequest, res) => {
  try { return res.json(await patientAutomations(req.params.patientId)); }
  catch (e) { return fail(res, e); }
});

router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.automation.findUnique({ where: { id: req.params.id } });
    return a ? res.json(a) : res.status(404).json({ error: 'NOT_FOUND' });
  } catch (e) { return fail(res, e); }
});

router.get('/:id/results', async (req: AuthRequest, res) => {
  try {
    const r = await automationResults(req.params.id);
    return r ? res.json(r) : res.status(404).json({ error: 'NOT_FOUND' });
  } catch (e) { return fail(res, e); }
});

router.get('/:id/preview', async (req: AuthRequest, res) => {
  try {
    const r = await dryRun(req.params.id, req.query.limit ? Number(req.query.limit) : 20);
    return r ? res.json(r) : res.status(404).json({ error: 'NOT_FOUND' });
  } catch (e) { return fail(res, e); }
});

router.post('/:id/simulate', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.automation.findUnique({ where: { id: req.params.id } });
    if (!a) return res.status(404).json({ error: 'NOT_FOUND' });
    const { patientId, visitId, events } = req.body ?? {};
    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      select: {
        id: true, patientId: true, branchId: true, updatedAt: true, totalAmountInPaise: true,
        patient: {
          select: {
            yearOfBirth: true, gender: true, marketingOptIn: true,
            identifiers: { where: { type: 'PHONE' }, select: { value: true } },
          },
        },
      },
    });
    if (!visit) return res.status(400).json({ error: 'VISIT_NOT_FOUND' });

    const steps = await simulate(
      a.definition as unknown as AutomationDefinition,
      {
        patientId: patientId ?? visit.patientId,
        visitId: visit.id,
        branchId: visit.branchId,
        triggeredAt: visit.updatedAt,
        marketingOptIn: visit.patient.marketingOptIn,
        phone: visit.patient.identifiers[0]?.value ?? null,
        yearOfBirth: visit.patient.yearOfBirth,
        gender: visit.patient.gender,
        visitValueInPaise: visit.totalAmountInPaise,
      },
      Array.isArray(events) ? events : [],
    );
    return res.json({ steps });
  } catch (e) { return fail(res, e); }
});

router.post('/', async (req: AuthRequest, res) => {
  try {
    const { key, name, group, definition } = req.body ?? {};
    if (!key || !name || !definition) return res.status(400).json({ error: 'KEY_NAME_DEFINITION_REQUIRED' });
    // Created DISABLED with no watermark. An automation that could message anyone the
    // moment it is saved is one slip away from a campaign nobody approved.
    const a = await prisma.automation.create({
      data: {
        key, name, group: group ?? 'Patient journeys',
        definition: definition as object,
        enabled: false, activatedAt: null,
        holdoutPct: req.body.holdoutPct ?? 0,
        priority: req.body.priority ?? 3,
        branchIds: req.body.branchIds ?? [],
      },
    });
    return res.status(201).json(a);
  } catch (e) { return fail(res, e); }
});

/**
 * Consent, for the Patient 360 header. Two switches, not one: opt-IN is per patient,
 * opt-OUT is per phone. A patient who replied STOP cannot be switched back on from
 * here — a switch a staff member can flip is not an opt-out, it is a suggestion.
 */
router.get('/consent/:patientId', async (req: AuthRequest, res) => {
  try {
    const p = await prisma.patient.findUnique({
      where: { id: req.params.patientId },
      select: {
        id: true, whatsappOptIn: true, whatsappOptInAt: true,
        marketingOptIn: true, marketingOptInAt: true, marketingOptInSource: true,
        deceasedAt: true,
        identifiers: { where: { type: 'PHONE' }, select: { value: true, isPrimary: true } },
      },
    });
    if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
    const phone = p.identifiers.find((i) => i.isPrimary)?.value ?? p.identifiers[0]?.value ?? null;
    const optOut = phone
      ? await prisma.phoneOptOut.findUnique({ where: { phone } })
      : null;
    // Everyone else on this handset, because the opt-out applies to all of them.
    const sharedWith = phone
      ? await prisma.patientIdentifier.count({ where: { type: 'PHONE', value: phone } })
      : 0;
    return res.json({
      phone,
      service: { on: p.whatsappOptIn, since: p.whatsappOptInAt },
      marketing: {
        on: p.marketingOptIn && !optOut,
        since: p.marketingOptInAt,
        source: p.marketingOptInSource,
        blockedByPhoneOptOut: !!optOut,
        optedOutAt: optOut?.optedOutAt ?? null,
        optedOutSource: optOut?.source ?? null,
        /// Only the patient can lift an inbound STOP, by replying START.
        staffCanReEnable: optOut?.source !== 'INBOUND_STOP',
      },
      deceasedAt: p.deceasedAt,
      phoneSharedWithPatients: sharedWith,
    });
  } catch (e) { return fail(res, e); }
});

router.put('/consent/:patientId', async (req: AuthRequest, res) => {
  try {
    const { marketingOptIn, reason } = req.body ?? {};
    if (typeof marketingOptIn !== 'boolean') return res.status(400).json({ error: 'MARKETING_OPT_IN_REQUIRED' });

    const p = await prisma.patient.findUnique({
      where: { id: req.params.patientId },
      select: { identifiers: { where: { type: 'PHONE' }, select: { value: true, isPrimary: true } } },
    });
    if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
    const phone = p.identifiers.find((i) => i.isPrimary)?.value ?? p.identifiers[0]?.value ?? null;

    if (phone) {
      const existing = await prisma.phoneOptOut.findUnique({ where: { phone } });
      if (existing?.source === 'INBOUND_STOP' && marketingOptIn) {
        return res.status(409).json({ error: 'PATIENT_OPTED_OUT_BY_REPLY' });
      }
    }

    await prisma.patient.update({
      where: { id: req.params.patientId },
      data: marketingOptIn
        ? { marketingOptIn: true, marketingOptInAt: new Date(), marketingOptInSource: 'COUNTER' }
        : { marketingOptIn: false },
    });

    if (!marketingOptIn && phone) {
      await prisma.phoneOptOut.upsert({
        where: { phone },
        create: { phone, source: 'STAFF', byUserId: req.user?.id ?? null, reason: reason ?? null },
        update: { source: 'STAFF', byUserId: req.user?.id ?? null, reason: reason ?? null, optedOutAt: new Date() },
      });
      // A patient part-way through a journey stops there rather than keeping a place
      // in something they have just asked to leave.
      await prisma.automationRun.updateMany({
        where: { patientId: req.params.patientId, state: { in: ['PENDING', 'RUNNING'] } },
        data: { state: 'STOPPED', stopReason: 'PHONE_OPTED_OUT', nextActionAt: null },
      });
    } else if (marketingOptIn && phone) {
      await prisma.phoneOptOut.deleteMany({ where: { phone, source: { not: 'INBOUND_STOP' } } });
    }

    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'Patient',
      entityId: req.params.patientId, userId: req.user?.id,
      newValues: JSON.stringify({ marketingOptIn, reason: reason ?? null }),
    });
    return res.json({ ok: true });
  } catch (e) { return fail(res, e); }
});

/** Saving never activates. Activation is its own act, with its own confirmation. */
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const def = req.body?.definition as AutomationDefinition | undefined;
    if (!def) return res.status(400).json({ error: 'DEFINITION_REQUIRED' });

    const unknown = [
      ...(def.audience ? unknownPredicates(def.audience) : []),
      ...(def.goal?.condition ? unknownPredicates(def.goal.condition) : []),
      ...def.steps.flatMap((s) => (s.kind === 'CHECK' ? unknownPredicates(s.condition) : [])),
    ];
    if (unknown.length) return res.status(400).json({ error: `UNKNOWN_PREDICATE: ${unknown.join(', ')}` });

    // A goTo pointing nowhere is a run that stops dead in production, and nothing in the
    // shape of the JSON catches it. Refuse at save rather than strand a patient.
    const blocking = validateDefinition(def as never).filter((p) => p.blocking);
    if (blocking.length) {
      return res.status(400).json({ error: `${blocking[0].where}: ${blocking[0].problem}` });
    }

    // Arity is checked HERE, where it is a dialog. Caught at send time it is a failure
    // for every patient in the run.
    try {
      const templates = await listMessageTemplates();
      for (const s of def.steps) {
        if (s.kind !== 'SEND') continue;
        const t = templates.find((x) => x.name === s.template);
        if (!t) return res.status(400).json({ error: `TEMPLATE_NOT_FOUND: ${s.template}` });
        if (t.status !== 'APPROVED') {
          return res.status(400).json({ error: `TEMPLATE_NOT_APPROVED: ${s.template} is ${t.status}` });
        }
        if (t.paramCount !== s.params.length) {
          return res.status(400).json({
            error: `TEMPLATE_ARITY: ${s.template} expects ${t.paramCount}, ${s.params.length} bound`,
          });
        }
      }
    } catch {
      // Meta unreachable: saving a draft must not depend on their API being up.
    }

    const updated = await prisma.automation.update({
      where: { id: req.params.id },
      data: {
        definition: def as object,
        ...(req.body.name ? { name: req.body.name } : {}),
        ...(req.body.holdoutPct !== undefined ? { holdoutPct: req.body.holdoutPct } : {}),
        ...(req.body.priority !== undefined ? { priority: req.body.priority } : {}),
        ...(req.body.branchIds ? { branchIds: req.body.branchIds } : {}),
      },
    });
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'Automation',
      entityId: updated.id, userId: req.user?.id, newValues: JSON.stringify({ version: updated.version }),
    });
    return res.json(updated);
  } catch (e) { return fail(res, e); }
});

/**
 * Activate. The watermark is set HERE and never back-dated: runs enrol only subjects
 * created after this instant, so a first activation cannot silently message six months
 * of history.
 */
router.post('/:id/activate', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.automation.update({
      where: { id: req.params.id },
      data: { enabled: true, activatedAt: new Date(), version: { increment: 1 } },
    });
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'Automation',
      entityId: a.id, userId: req.user?.id, newValues: JSON.stringify({ activated: true, version: a.version }),
    });
    return res.json(a);
  } catch (e) { return fail(res, e); }
});

/** Pause stops enrolment. In-flight runs keep their place and finish. */
router.post('/:id/pause', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.automation.update({ where: { id: req.params.id }, data: { enabled: false } });
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'Automation',
      entityId: a.id, userId: req.user?.id, newValues: JSON.stringify({ paused: true }),
    });
    return res.json(a);
  } catch (e) { return fail(res, e); }
});

/** Stop cancels every live run as well. Different word, different consequence. */
router.post('/:id/stop', async (req: AuthRequest, res) => {
  try {
    const a = await prisma.automation.update({ where: { id: req.params.id }, data: { enabled: false } });
    const killed = await prisma.automationRun.updateMany({
      where: { automationId: a.id, state: { in: ['PENDING', 'RUNNING'] } },
      data: { state: 'STOPPED', stopReason: 'STOPPED_AUTOMATION_STOPPED', nextActionAt: null },
    });
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'Automation',
      entityId: a.id, userId: req.user?.id, newValues: JSON.stringify({ stopped: true, runsCancelled: killed.count }),
    });
    return res.json({ automation: a, runsCancelled: killed.count });
  } catch (e) { return fail(res, e); }
});

export default router;

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
import { unknownPredicates } from '../services/automations/predicates';
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

router.get('/activity', async (req: AuthRequest, res) => {
  try {
    return res.json({
      rows: await activity({
        automationId: req.query.automationId as string | undefined,
        outcome: req.query.outcome as string | undefined,
        patientId: req.query.patientId as string | undefined,
        days: req.query.days ? Number(req.query.days) : undefined,
      }),
    });
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

/** Saving never activates. Activation is its own act, with its own confirmation. */
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const def = req.body?.definition as AutomationDefinition | undefined;
    if (!def) return res.status(400).json({ error: 'DEFINITION_REQUIRED' });

    const unknown = [
      ...unknownPredicates(def.audience),
      ...unknownPredicates(def.goal.condition),
      ...def.steps.flatMap((s) => (s.kind === 'CHECK' ? unknownPredicates(s.condition) : [])),
    ];
    if (unknown.length) return res.status(400).json({ error: `UNKNOWN_PREDICATE: ${unknown.join(', ')}` });

    // Arity is checked HERE, where it is a dialog. Caught at send time it is a failure
    // for every patient in the run.
    try {
      const templates = await listMessageTemplates();
      for (const s of def.steps) {
        if (s.kind !== 'SEND') continue;
        const t = templates.find((x) => x.name === s.template);
        if (!t) return res.status(400).json({ error: `TEMPLATE_NOT_APPROVED: ${s.template}` });
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

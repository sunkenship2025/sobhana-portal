/**
 * Smart Reports — staff + admin surface.
 * Public (patient) routes live in reportDownload.ts so they reuse the existing
 * token door: validateToken + patientLinkBlock + rate limiters.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { logAction } from '../services/auditService';
import { generateSmartReport } from '../services/smartReport/generate';
import { renderStored, renderDraft } from '../services/smartReport/present';
import { produceSmartReport, persistDraftSmartReport } from '../services/smartReport/generate';
import { buildBuckets, type SnapshotLike } from '../services/smartReport/findings';
import { resolveVisitScope } from '../services/smartReport/eligibility';
import { buildEphemeralSnapshot } from '../services/reportSnapshotService';
// The completeness rule lives with finalize, and is imported rather than
// restated: a second copy would drift, and then the preview would offer itself
// on a report finalize still considers incomplete.
import { findIncompleteOrders, hasMeaningfulResultRow } from './diagnosticVisits';
import { checkPackage } from '../services/smartReport/packageEligibility';
import { loadConfig } from '../services/smartReport/config';

const router = Router();
router.use(authMiddleware);

/** Latest finalized version for a visit — everything below keys off this. */
async function latestFinalized(visitId: string): Promise<string | null> {
  const v = await prisma.reportVersion.findFirst({
    where: { status: 'FINALIZED', report: { visitId } },
    orderBy: { versionNum: 'desc' },
    select: { id: true },
  });
  return v?.id ?? null;
}

// ─── status for the preview toggle ────────────────────────────────────────
router.get('/visits/:visitId/status', async (req: AuthRequest, res) => {
  try {
    const reportVersionId = await latestFinalized(req.params.visitId);
    if (!reportVersionId) return res.json({ available: false, status: 'NO_REPORT' });

    const sr = await prisma.smartReport.findUnique({
      where: { reportVersionId },
      select: {
        status: true, skipReason: true, score: true, scoreBand: true,
        usedFallbackCopy: true, hasCritical: true, generatedAt: true,
      },
    });
    return res.json({
      available: sr?.status === 'READY',
      reportVersionId,
      status: sr?.status ?? 'PENDING',
      skipReason: sr?.skipReason ?? null,
      score: sr?.score ?? null,
      scoreBand: sr?.scoreBand ?? null,
      usedFallbackCopy: sr?.usedFallbackCopy ?? false,
      hasCritical: sr?.hasCritical ?? false,
      generatedAt: sr?.generatedAt ?? null,
    });
  } catch (err) {
    console.error('GET smart-report status failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── staff HTML preview (the [Report | Smart Report] toggle target) ───────
router.get('/visits/:visitId/preview', async (req: AuthRequest, res) => {
  try {
    const reportVersionId = await latestFinalized(req.params.visitId);
    if (!reportVersionId) return res.status(404).send('No finalized report for this visit.');
    const html = await renderStored(reportVersionId);
    if (!html) return res.status(404).send('No Smart Report for this visit yet.');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (err) {
    console.error('GET smart-report preview failed:', err);
    return res.status(500).send('Failed to render Smart Report');
  }
});

// ─── regenerate ───────────────────────────────────────────────────────────
router.post('/visits/:visitId/generate', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const reportVersionId = await latestFinalized(req.params.visitId);
    if (!reportVersionId) return res.status(400).json({ error: 'NO_FINALIZED_REPORT' });

    await generateSmartReport(reportVersionId);
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'SmartReport',
      entityId: reportVersionId, userId: req.user!.id,
      newValues: { regenerated: true, visitId: req.params.visitId },
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });

    const sr = await prisma.smartReport.findUnique({
      where: { reportVersionId },
      select: { status: true, skipReason: true, score: true, usedFallbackCopy: true },
    });
    return res.json({ success: true, ...sr });
  } catch (err) {
    console.error('POST smart-report generate failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * Withdraw (or restore) a Smart Report.
 *
 * Generation and the first WhatsApp both hang off finalize, fire-and-forget, so
 * there is no window in which staff could pre-empt the first message. This is the
 * after-the-fact remedy: the smart page stops being served, and every resend falls
 * back to the plain one-button template. The signed lab report is untouched.
 *
 * Reason is mandatory when withdrawing — this is a deliberate act on something a
 * patient may already have opened, and the audit trail should say why.
 */
router.put('/visits/:visitId/send-suppressed', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const suppressed = req.body?.suppressed === true;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (suppressed && reason.length < 3) return res.status(400).json({ error: 'REASON_REQUIRED' });

    const reportVersionId = await latestFinalized(req.params.visitId);
    if (!reportVersionId) return res.status(400).json({ error: 'NO_FINALIZED_REPORT' });
    const existing = await prisma.smartReport.findUnique({
      where: { reportVersionId }, select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'NO_SMART_REPORT' });

    const updated = await prisma.smartReport.update({
      where: { reportVersionId },
      data: suppressed
        ? { sendSuppressedAt: new Date(), sendSuppressedBy: req.user!.id, sendSuppressedReason: reason }
        : { sendSuppressedAt: null, sendSuppressedBy: null, sendSuppressedReason: null },
      select: { status: true, usedFallbackCopy: true, sendSuppressedAt: true, score: true },
    });

    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'SmartReport',
      entityId: reportVersionId, userId: req.user!.id,
      newValues: { sendSuppressed: suppressed, reason: suppressed ? reason : null, visitId: req.params.visitId },
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    });

    return res.json({ success: true, ...updated, sendSuppressed: updated.sendSuppressedAt !== null });
  } catch (err) {
    console.error('PUT smart-report send-suppressed failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * Is every order in the SMART-REPORT BUNDLE filled in? Same completeness rule
 * finalize applies, narrowed to the products that actually feed the report.
 *
 * Visit-wide was the wrong scope: buildBuckets only ever scores panels in
 * scope.inScopePanelIds, so an unrelated order on the same visit — a standalone
 * X-ray next to a Master Health Check — could block the preview while being
 * unable to appear in it or move the score. Inside the bundle the rule stays
 * absolute: no partial, because a score over half a package is meaningless.
 */
async function draftCompleteness(
  visitId: string,
  inScopeProductIds: Set<string>,
): Promise<{ complete: boolean; pending: string[] }> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      testOrders: {
        select: {
          id: true, testId: true, productId: true, workflowMode: true, noReportAt: true, cancelledAt: true,
          externalUploads: { select: { id: true } },
          test: { select: { name: true, isPanel: true, childTests: { select: { id: true } } } },
        },
      },
      report: {
        select: {
          versions: {
            orderBy: { versionNum: 'desc' }, take: 1,
            select: { testResults: { select: { testOrderId: true, testId: true, value: true, textValue: true, notes: true } } },
          },
        },
      },
    },
  });
  if (!visit) return { complete: false, pending: [] };

  const results = visit.report?.versions?.[0]?.testResults ?? [];
  const filled = new Set(
    results.filter(hasMeaningfulResultRow).map((r) => `${r.testOrderId}:${r.testId}`),
  );
  const inBundle = visit.testOrders.filter(
    (o) => o.productId && inScopeProductIds.has(o.productId),
  );
  // findIncompleteOrders([]) is [], which would read as "complete" and let a
  // preview through with nothing entered. scope.ok already implies a non-empty
  // bundle, but that invariant lives in another function — so fail closed here.
  if (!inBundle.length) return { complete: false, pending: [] };
  const incomplete = findIncompleteOrders(inBundle as any, filled);
  return {
    complete: incomplete.length === 0,
    pending: incomplete.map((o: any) => o.test?.name ?? 'a test'),
  };
}

/**
 * Draft preview: the Smart Report for a visit that has NOT been finalized yet.
 *
 * Runs produceSmartReport over buildEphemeralSnapshot — the same snapshot the
 * draft PDF preview is built from, and the same pipeline the real generation
 * uses — so what staff see here is what the patient will get. Nothing is
 * persisted: no SmartReport row, no WhatsApp, no access token.
 *
 * Refuses unless every reportable order has a result. A score computed over half
 * a package is meaningless, and the completeness rule is imported from the
 * finalize route rather than restated so the two cannot drift.
 */
router.get('/visits/:visitId/draft-status', async (req: AuthRequest, res) => {
  try {
    const cfg = await loadConfig(req.branchId ?? null);
    // Switched off for this branch: no tab, no toggle, no trace. Staff at a branch
    // that has not adopted Smart Reports should never see the feature exists.
    if (!cfg.enabled) return res.json({ complete: false, pending: [], enabled: false });
    const scope = await resolveVisitScope(req.params.visitId, cfg);
    // Nothing on this visit produces a Smart Report — report it as not-ready so
    // the tab stays disabled, rather than enabling it to fail with a 409 later.
    if (!scope.ok) return res.json({ complete: false, pending: [] });
    const status = await draftCompleteness(req.params.visitId, scope.inScopeProductIds);
    return res.json(status);
  } catch (err) {
    console.error('GET smart-report draft-status failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/visits/:visitId/draft-preview', async (req: AuthRequest, res) => {
  try {
    const visitId = req.params.visitId;

    // Gated on cfg.enabled. This route used to be deliberately ungated so content
    // could be reviewed before arming delivery — but with the switch now per
    // branch, OFF has to mean the feature is invisible, not merely unsent. A
    // branch that wants to review first turns it on for that branch alone.
    // Stage timings, because the staff-facing wait had only ever been measured
    // from a laptop across the Pacific — where a DB round trip is ~285ms and the
    // Redis reference-range cache is absent, so both look far worse than they are.
    const t0 = Date.now();
    const cfg = await loadConfig(req.branchId ?? null);
    if (!cfg.enabled) return res.status(409).json({ error: 'DISABLED' });

    const tCfg = Date.now();
    const scope = await resolveVisitScope(visitId, cfg);
    if (!scope.ok) return res.status(409).json({ error: scope.skipReason ?? 'NO_SMART_REPORT_PRODUCT' });

    // Completeness needs the scope, so it runs after it: only the enabled bundle
    // has to be fully entered.
    const status = await draftCompleteness(visitId, scope.inScopeProductIds);
    if (!status.complete) {
      return res.status(409).json({ error: 'INCOMPLETE_REPORT', pending: status.pending });
    }

    const tScope = Date.now();
    const snapshot = await buildEphemeralSnapshot(visitId);
    const tSnap = Date.now();
    const buckets = buildBuckets(
      snapshot as unknown as SnapshotLike,
      scope.inScopePanelIds.size ? scope.inScopePanelIds : null,
      cfg.excludedTestCodes,
    );
    if (buckets.counts.scored < cfg.minScoredParameters) {
      return res.status(409).json({ error: 'BELOW_MIN_PARAMETERS', scored: buckets.counts.scored });
    }

    // The snapshot already carries the visit; a second findUnique here was a
    // redundant round trip.
    const visit = {
      id: snapshot.visit.visitId,
      createdAt: new Date(snapshot.visit.createdAt),
      patientId: snapshot.patient.patientId,
    };

    // Reuse a previous generation when nothing about the model's input changed.
    // Not only to skip a paid call: the model is non-deterministic, so re-asking
    // would show staff different words each time they opened the same report.
    const prior = await prisma.smartReport.findUnique({
      where: { reportVersionId: snapshot.reportVersionId },
      select: { inputHash: true, content: true, usedFallbackCopy: true },
    });

    const produceStarted = Date.now();
    const produced = await produceSmartReport({
      buckets, visit, patientSnapshot: snapshot.patient as any, scope, cfg,
      logRef: `draft:${visitId}`,
      // A stored fallback is template copy, not a generation — reusing it would
      // permanently pin the report to the non-AI path.
      reuse: prior && !prior.usedFallbackCopy
        ? { inputHash: prior.inputHash, content: prior.content }
        : null,
    });

    // Persisted so finalize can hand the patient exactly these words, and so a
    // fallback is visible instead of silently degrading.
    await persistDraftSmartReport({
      reportVersionId: snapshot.reportVersionId,
      visitId,
      patientId: snapshot.patient.patientId,
      branchId: req.branchId ?? snapshot.visit.branchId,
      cfg, scope, produced,
      generationMs: Date.now() - produceStarted,
    }).catch((e) => console.error('smart-report draft persist failed:', e));

    const tLlm = Date.now();
    const html = await renderDraft(snapshot, produced, scope, cfg);
    console.log('[smart-report draft-preview] timing', JSON.stringify({
      visitId,
      totalMs: Date.now() - t0,
      configMs: tCfg - t0,
      scopeMs: tScope - tCfg,
      snapshotMs: tSnap - tScope,
      produceMs: tLlm - tSnap,
      renderMs: Date.now() - tLlm,
      scored: buckets.counts.scored,
      fallback: produced.usedFallback,
      reused: produced.reusedStored,
      // why the model output was rejected — without these a fallback is silent
      // and the report quietly degrades to template copy
      failures: produced.failures,
    }));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (err) {
    console.error('GET smart-report draft-preview failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── can this package have Smart Reports switched on? ─────────────────────
router.get('/products/:productId/eligibility', async (_req: AuthRequest, res) => {
  try {
    const [check, product] = await Promise.all([
      checkPackage(_req.params.productId),
      prisma.billableProduct.findUnique({
        where: { id: _req.params.productId },
        select: { smartReportEnabled: true },
      }),
    ]);
    return res.json({ ...check, enabled: product?.smartReportEnabled ?? false });
  } catch (err) {
    console.error('GET package eligibility failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.put('/products/:productId/enabled', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    if (enabled) {
      const check = await checkPackage(req.params.productId);
      if (!check.eligible) {
        return res.status(400).json({ error: 'PACKAGE_NOT_ELIGIBLE', reasons: check.reasons });
      }
    }
    await prisma.billableProduct.update({
      where: { id: req.params.productId },
      data: { smartReportEnabled: enabled },
    });
    return res.json({ success: true, smartReportEnabled: enabled });
  } catch (err) {
    console.error('PUT product smart-report toggle failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── height / weight, captured in billing when a Smart-Report bundle is billed ──
// Stored on the VISIT. They used to live on Patient and be read LIVE at render
// time, so re-weighing a patient silently rewrote the BMI on every one of their
// past finalized reports — the mutation the frozen snapshots exist to prevent.
// Both optional: the Health Essentials page is omitted when either is missing,
// never estimated.
router.put('/visits/:visitId/measurements', async (req: AuthRequest, res) => {
  try {
    const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    const heightCm = num(req.body?.heightCm);
    const weightKg = num(req.body?.weightKg);
    // NaN fails both comparisons, so non-numeric input is rejected here too.
    if ((heightCm !== null && !(heightCm > 30 && heightCm < 260))
      || (weightKg !== null && !(weightKg > 1 && weightKg < 400))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Height or weight is out of range' });
    }
    // Blank means "not measured", never "erase what was measured". A recorded
    // weight is a real observation and a point on the patient's trend; a later
    // save that leaves the field empty must not destroy it.
    const data: { heightCm?: number; weightKg?: number } = {};
    if (heightCm !== null) data.heightCm = heightCm;
    if (weightKg !== null) data.weightKg = weightKg;
    if (!Object.keys(data).length) {
      const current = await prisma.visit.findUnique({
        where: { id: req.params.visitId },
        select: { id: true, patientId: true, heightCm: true, weightKg: true },
      });
      return res.json(current);
    }
    const visit = await prisma.visit.update({
      where: { id: req.params.visitId },
      data,
      select: { id: true, patientId: true, heightCm: true, weightKg: true },
    });
    // Height carries forward to prefill the next bill. Weight deliberately does
    // not — it is re-measured each visit, and a stale prefill accepted without
    // anyone noticing is exactly how a wrong BMI reaches a patient.
    if (heightCm !== null) {
      await prisma.patient
        .update({ where: { id: visit.patientId }, data: { heightCm } })
        .catch(() => undefined);
    }
    return res.json(visit);
  } catch (err) {
    console.error('PUT visit measurements failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── config ───────────────────────────────────────────────────────────────
router.get('/config', async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId ?? null;
    // `scope` lets the UI say "inherited from global" vs "overridden here" without
    // re-deriving the ladder client-side and getting it subtly different.
    const override = branchId
      ? await prisma.smartReportConfig.findFirst({ where: { branchId }, select: { id: true } })
      : null;
    const cfg = await loadConfig(branchId);
    return res.json({ ...cfg, scope: override ? 'branch' : 'global', branchId });
  } catch (err) {
    console.error('GET smart-report config failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/**
 * Drop this branch's override so it inherits the global default again. Deleting
 * the row IS the "use global" state — no third value, nothing to keep in sync.
 */
router.delete('/config', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId ?? null;
    if (!branchId) return res.status(400).json({ error: 'NO_BRANCH' });
    await prisma.smartReportConfig.deleteMany({ where: { branchId } });
    return res.json({ ...(await loadConfig(branchId)), scope: 'global', branchId });
  } catch (err) {
    console.error('DELETE smart-report config failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

/** loadConfig returns derived shape; only real columns can be written back. */
function stripComputed(cfg: Awaited<ReturnType<typeof loadConfig>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of EDITABLE) if (k in cfg) out[k] = (cfg as any)[k];
  return out;
}

const EDITABLE = [
  'enabled', 'recommendationsEnabled', 'futureTestsEnabled', 'trendsEnabled',
  'essentialsEnabled', 'language', 'accentColor', 'tagline', 'websiteLine',
  'disclaimerOverride', 'minScoredParameters', 'minPatientAgeYears',
  'maxFindingPages', 'model', 'monthlyBudgetPaise',
] as const;

router.put('/config', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const data: Record<string, unknown> = {};
    for (const k of EDITABLE) if (k in (req.body ?? {})) data[k] = req.body[k];
    // scope 'branch' writes an override for the ACTIVE branch; anything else edits
    // the global default every branch inherits. A branch row exists only when
    // somebody deliberately diverged — that is what keeps this from becoming a
    // per-branch config nobody remembers to maintain.
    const branchScoped = req.body?.scope === 'branch';
    const branchId = branchScoped ? (req.branchId ?? null) : null;
    if (branchScoped && !branchId) {
      return res.status(400).json({ error: 'NO_BRANCH', message: 'No active branch to override' });
    }
    const existing = await prisma.smartReportConfig.findFirst({ where: { branchId } });
    const saved = existing
      ? await prisma.smartReportConfig.update({ where: { id: existing.id }, data })
      // A brand-new override starts from the INHERITED values, not the hardcoded
      // defaults — otherwise flipping one switch silently resets everything else.
      : await prisma.smartReportConfig.create({
          data: { branchId, ...(branchId ? stripComputed(await loadConfig(null)) : {}), ...data } as any,
        });
    return res.json(saved);
  } catch (err) {
    console.error('PUT smart-report config failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

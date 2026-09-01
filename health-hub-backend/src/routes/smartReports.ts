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
import { produceSmartReport } from '../services/smartReport/generate';
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

/** Is every reportable order on this visit filled in? Same rule finalize applies. */
async function draftCompleteness(visitId: string): Promise<{ complete: boolean; pending: string[] }> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      testOrders: {
        select: {
          id: true, testId: true, workflowMode: true, noReportAt: true, cancelledAt: true,
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
  const incomplete = findIncompleteOrders(visit.testOrders as any, filled);
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
    const status = await draftCompleteness(req.params.visitId);
    return res.json(status);
  } catch (err) {
    console.error('GET smart-report draft-status failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.get('/visits/:visitId/draft-preview', async (req: AuthRequest, res) => {
  try {
    const visitId = req.params.visitId;
    const status = await draftCompleteness(visitId);
    if (!status.complete) {
      return res.status(409).json({ error: 'INCOMPLETE_REPORT', pending: status.pending });
    }

    // Deliberately NOT gated on cfg.enabled. That flag arms generation at finalize
    // and the patient WhatsApp; this route sends nothing and persists nothing, it
    // only lets staff read what a patient WOULD get. Requiring the same switch
    // would mean turning delivery on in order to review the content first, which
    // is exactly backwards.
    const cfg = await loadConfig(req.branchId ?? null);

    const scope = await resolveVisitScope(visitId, cfg);
    if (!scope.ok) return res.status(409).json({ error: scope.skipReason ?? 'NO_SMART_REPORT_PRODUCT' });

    const snapshot = await buildEphemeralSnapshot(visitId);
    const buckets = buildBuckets(
      snapshot as unknown as SnapshotLike,
      scope.inScopePanelIds.size ? scope.inScopePanelIds : null,
      cfg.excludedTestCodes,
    );
    if (buckets.counts.scored < cfg.minScoredParameters) {
      return res.status(409).json({ error: 'BELOW_MIN_PARAMETERS', scored: buckets.counts.scored });
    }

    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      select: { id: true, createdAt: true, patientId: true },
    });
    if (!visit) return res.status(404).json({ error: 'VISIT_NOT_FOUND' });

    const produced = await produceSmartReport({
      buckets, visit, patientSnapshot: snapshot.patient as any, scope, cfg,
      logRef: `draft:${visitId}`,
    });

    const html = await renderDraft(snapshot, produced, scope, cfg);
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
// The UI lives in the billing screen (wireframes pending); this is the endpoint
// it calls. Both optional: the Health Essentials page is omitted when either is
// missing, never estimated.
router.put('/patients/:patientId/measurements', async (req: AuthRequest, res) => {
  try {
    const h = req.body?.heightCm;
    const w = req.body?.weightKg;
    const num = (v: unknown) => (v === null || v === '' || v === undefined ? null : Number(v));
    const heightCm = num(h);
    const weightKg = num(w);
    if ((heightCm !== null && !(heightCm > 30 && heightCm < 260))
      || (weightKg !== null && !(weightKg > 1 && weightKg < 400))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Height or weight is out of range' });
    }
    const patient = await prisma.patient.update({
      where: { id: req.params.patientId },
      data: { heightCm, weightKg },
      select: { id: true, heightCm: true, weightKg: true },
    });
    return res.json(patient);
  } catch (err) {
    console.error('PUT patient measurements failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// ─── config ───────────────────────────────────────────────────────────────
router.get('/config', async (req: AuthRequest, res) => {
  try {
    return res.json(await loadConfig(req.branchId ?? null));
  } catch (err) {
    console.error('GET smart-report config failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

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
    const existing = await prisma.smartReportConfig.findFirst({ where: { branchId: null } });
    const saved = existing
      ? await prisma.smartReportConfig.update({ where: { id: existing.id }, data })
      : await prisma.smartReportConfig.create({ data: { branchId: null, ...data } as any });
    return res.json(saved);
  } catch (err) {
    console.error('PUT smart-report config failed:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

export default router;

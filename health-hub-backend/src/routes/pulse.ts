/**
 * Pulse — AI analytics over the read-only role. Owner-only for V1.
 * POST /ask    { q, state }  -> one answer (see services/pulse/index.ts)
 * GET  /today               -> the empty-state pack (cached 5 min; prefetch on hover)
 * GET  /health              -> knowledge freshness
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { ask, todayPack } from '../services/pulse';
import { ensureKnowledge, refreshKnowledge, touchNames } from '../services/pulse/knowledge';
import { logAction } from '../services/auditService';

const router = Router();
router.use(authMiddleware, branchContextMiddleware, requireRole('owner'));

router.get('/today', async (_req, res) => {
  touchNames();   // the panel is opening: if a doctor/test/branch was added or the schema changed, refresh
  try { res.json(await todayPack()); } catch (e: any) { res.status(503).json({ error: 'pulse_unavailable', message: String(e?.message || e).slice(0, 200) }); }
});

router.get('/health', async (_req, res) => {
  try { const k = await ensureKnowledge(); const broken = Object.entries(k.registryHealth).filter(([, v]) => v.startsWith('BROKEN'));
    res.status(broken.length ? 500 : 200).json({ ok: broken.length === 0, builtAt: k.builtAt, namesAt: k.namesAt, valueTerms: Object.keys(k.vidx).length, names: k.names.length, registry: k.registryHealth }); }
  catch (e: any) { res.status(503).json({ ok: false, message: String(e?.message || e).slice(0, 200) }); }
});

/** Rebuild everything now — after adding doctors/tests or changing the schema. ~60s on Neon. */
router.post('/refresh', async (_req, res) => {
  try { const k = await refreshKnowledge(); res.json({ ok: true, builtAt: k.builtAt, names: k.names.length, registry: k.registryHealth }); }
  catch (e: any) { res.status(503).json({ ok: false, message: String(e?.message || e).slice(0, 200) }); }
});

router.post('/ask', async (req: AuthRequest, res) => {
  const q = String(req.body?.q || '').trim();
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  const t0 = Date.now();
  try {
    const answer = await ask(q, req.body?.state || {});
    // Every question is auditable: who asked what, which path answered, and the SQL if any.
    // AuditActionType has no PULSE value yet (adding one is a migration); REPORT_ACCESS with
    // entityType 'Pulse' keeps it filterable until then.
    logAction({ userId: req.user!.id, branchId: req.branchId || '', actionType: 'REPORT_ACCESS', entityType: 'Pulse', entityId: String(answer.kind || 'unknown'),
      newValues: { q: q.slice(0, 300), kind: answer.kind, shape: answer.shape, sql: answer.provenance?.sql?.slice(0, 1000), ms: Date.now() - t0,
        // Replaying this log against the database is how the real defects were found — a figure
        // 100x too large, a "complete" list missing a debtor, a feature reported as non-existent.
        // Without the answer and the refusal reason none of that was visible after the fact.
        reason: (answer as any).reason, text: String((answer as any).text || '').slice(0, 600),
        steps: (answer as any).meta?.steps, calls: (answer as any).meta?.calls } }).catch(() => {});
    res.json(answer);
  } catch (e: any) {
    res.status(502).json({ kind: 'refuse', reason: 'error', text: 'Pulse could not answer that just now. Try again in a moment.', detail: String(e?.message || e).slice(0, 200) });
  }
});
export default router;

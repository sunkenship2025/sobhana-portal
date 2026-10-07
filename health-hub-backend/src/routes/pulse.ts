/**
 * Pulse — AI analytics over the read-only role. Owner-only for V1.
 * POST /ask    { q, state }  -> one answer (see services/pulse/index.ts)
 * GET  /today               -> the empty-state pack (cached 5 min; prefetch on hover)
 * GET  /health              -> knowledge freshness
 */
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { ask, todayPack } from '../services/pulse';
import { ensureKnowledge, refreshKnowledge, touchNames } from '../services/pulse/knowledge';
import { logAction } from '../services/auditService';
import { modelStatus, turnSignal } from '../services/pulse/llm';

/** The owner's request as an abort signal. `req` 'close' fires the moment the body has been read
 *  (Node 16+), not when the client goes — measured at 2ms — so it is the RESPONSE closing before
 *  it finished that means the panel was closed or Stop was pressed. */
function cancelOnClose(res: any): AbortController {
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  return ctrl;
}

const router = Router();

/** Who may see a result that identifies a patient. An authorization decision, made where the
 *  asker is known — not inferred from the shape of a query further down. */
const maySeePeople = (req: AuthRequest) => req.user?.role === 'owner' || req.user?.role === 'admin';
router.use(authMiddleware, branchContextMiddleware, requireRole('owner'));

router.get('/today', async (_req, res) => {
  touchNames();   // the panel is opening: if a doctor/test/branch was added or the schema changed, refresh
  // the model's state rides along, so a dead account shows on the panel before anyone asks
  try { const [pack, model] = await Promise.all([todayPack(), modelStatus()]); res.json({ ...pack, model }); }
  catch (e: any) { res.status(503).json({ error: 'pulse_unavailable', message: String(e?.message || e).slice(0, 200) }); }
});

router.get('/health', async (_req, res) => {
  try { const [k, model] = await Promise.all([ensureKnowledge(), modelStatus()]); const broken = Object.entries(k.registryHealth).filter(([, v]) => v.startsWith('BROKEN'));
    res.status(broken.length || !model.ok ? 500 : 200).json({ ok: broken.length === 0 && model.ok, model, builtAt: k.builtAt, namesAt: k.namesAt, valueTerms: Object.keys(k.vidx).length, names: k.names.length, registry: k.registryHealth }); }
  catch (e: any) { res.status(503).json({ ok: false, message: String(e?.message || e).slice(0, 200) }); }
});

/** Rebuild everything now — after adding doctors/tests or changing the schema. ~60s on Neon. */
router.post('/refresh', async (_req, res) => {
  try { const k = await refreshKnowledge(); res.json({ ok: true, builtAt: k.builtAt, names: k.names.length, registry: k.registryHealth }); }
  catch (e: any) { res.status(503).json({ ok: false, message: String(e?.message || e).slice(0, 200) }); }
});

/**
 * The full decision trace for one turn, written as its own audit row. Every defect found in
 * Pulse so far was found by replaying this log against the database — and the log held only
 * summaries, so each one needed a fresh reproduction before it could even be seen. This records
 * what the turn actually decided: the plan, every step and how long it took, which hypotheses
 * were settled, which renderers the evidence admitted and which was chosen, and whether the
 * response had to be repaired.
 *
 * Kept as a SEPARATE row from the answer audit so the answer row stays small and readable, and
 * so a trace can be dropped or retained on its own schedule.
 */
function logTrace(req: AuthRequest, answer: any, ms: number) {
  const trace = (answer as any)?.trace;
  if (!trace) return;
  let payload = trace;
  // A runaway investigation must not write a megabyte into the audit table.
  try {
    if (JSON.stringify(trace).length > 24_000) {
      payload = { ...trace, executed: (trace.executed || []).map((e: any) => ({ ...e, sql: undefined })),
        answer: { ...trace.answer, text: String(trace.answer?.text || '').slice(0, 400) }, truncated: true };
    }
  } catch { return; }
  logAction({ userId: req.user!.id, branchId: req.branchId || '', actionType: 'REPORT_ACCESS',
    entityType: 'PulseTrace', entityId: String(answer.job || answer.kind || 'turn'),
    newValues: { ...payload, ms } }).catch(() => {});
}

router.post('/ask', async (req: AuthRequest, res) => {
  const q = String(req.body?.q || '').trim();
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  const t0 = Date.now();
  const ctrl = cancelOnClose(res);
  const turn = randomUUID();
  try {
    // Authorization is decided HERE, where the asker is known, and passed down as policy. The
    // route is requireRole('owner'), so row-level detail about their own patients is theirs to
    // see; a future staff or shared surface sets this false and the validator withholds names.
    const answer = await turnSignal.run(ctrl.signal, () => ask(q, req.body?.state || {}, { rowLevel: maySeePeople(req) }));
    // Every question is auditable: who asked what, which path answered, and the SQL if any.
    // AuditActionType has no PULSE value yet (adding one is a migration); REPORT_ACCESS with
    // entityType 'Pulse' keeps it filterable until then.
    logAction({ userId: req.user!.id, branchId: req.branchId || '', actionType: 'REPORT_ACCESS', entityType: 'Pulse', entityId: String(answer.kind || 'unknown'),
      newValues: { turn, q: q.slice(0, 300), kind: answer.kind, shape: answer.shape, job: (answer as any).job, sql: answer.provenance?.sql?.slice(0, 1000), ms: Date.now() - t0,
        // Replaying this log against the database is how the real defects were found — a figure
        // 100x too large, a "complete" list missing a debtor, a feature reported as non-existent.
        // Without the answer and the refusal reason none of that was visible after the fact.
        reason: (answer as any).reason, text: String((answer as any).text || '').slice(0, 600),
        why: (answer as any).why, refusal: (answer as any).refusal,
        steps: (answer as any).meta?.steps, calls: (answer as any).meta?.calls } }).catch(() => {});
    logTrace(req, answer, Date.now() - t0);
    const { trace: _t, ...clean } = answer as any;   // the trace is for the log, not the wire
    res.json({ ...clean, turn });
  } catch (e: any) {
    res.status(502).json({ kind: 'refuse', reason: 'error', text: 'Pulse could not answer that just now. Try again in a moment.', detail: String(e?.message || e).slice(0, 200) });
  }
});
/**
 * The same question, but the work is visible while it happens. A deep investigation can take a
 * couple of minutes, and the panel was showing a canned three-line rotation on a timer with no
 * relationship to the work — so it looked like a hang. Here every step, every hypothesis settled
 * and every rule-out is sent as it happens, and the answer arrives last on the same connection.
 */
router.post('/ask/stream', async (req: AuthRequest, res) => {
  const q = String(req.body?.q || '').trim();
  if (!q) { res.status(400).json({ error: 'q required' }); return; }
  const t0 = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',     // a proxy that buffers this defeats the whole point
  });
  const send = (event: string, data: any) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
  };
  let alive = true;
  const ctrl = cancelOnClose(res);
  ctrl.signal.addEventListener('abort', () => { alive = false; });
  const turn = randomUUID();
  const beat = setInterval(() => alive && res.write(': keep-alive\n\n'), 15_000);
  try {
    const answer = await turnSignal.run(ctrl.signal, () => ask(q, req.body?.state || {}, { rowLevel: maySeePeople(req),
      onProgress: (text, kind) => { if (alive) send('progress', { text, kind: kind || 'step' }); } }));
    logAction({ userId: req.user!.id, branchId: req.branchId || '', actionType: 'REPORT_ACCESS', entityType: 'Pulse', entityId: String(answer.kind || 'unknown'),
      newValues: { turn, q: q.slice(0, 300), kind: answer.kind, job: (answer as any).job, sql: answer.provenance?.sql?.slice(0, 1000), ms: Date.now() - t0,
        reason: (answer as any).reason, text: String((answer as any).text || '').slice(0, 600),
        why: (answer as any).why, refusal: (answer as any).refusal,
        steps: (answer as any).meta?.steps, calls: (answer as any).meta?.calls, streamed: true } }).catch(() => {});
    logTrace(req, answer, Date.now() - t0);
    const { trace: _t, ...clean } = answer as any;
    send('answer', { ...clean, turn });
  } catch (e: any) {
    send('answer', { kind: 'refuse', reason: 'error', text: 'Pulse could not answer that just now. Try again in a moment.', detail: String(e?.message || e).slice(0, 200) });
  } finally { clearInterval(beat); res.end(); }
});

/** A thumbs up or down on one answer, tied to its audit row by the turn id. The down votes with a
 *  note are the next benchmark cases; the up votes on catalog answers are verified examples. */
router.post('/feedback', async (req: AuthRequest, res) => {
  const turn = String(req.body?.turn || '').slice(0, 64);
  const rating = req.body?.rating === 'up' ? 'up' : req.body?.rating === 'down' ? 'down' : null;
  if (!turn || !rating) { res.status(400).json({ error: 'turn and rating required' }); return; }
  await logAction({ userId: req.user!.id, branchId: req.branchId || '', actionType: 'REPORT_ACCESS', entityType: 'PulseFeedback', entityId: turn,
    newValues: { rating, q: String(req.body?.q || '').slice(0, 300), note: String(req.body?.note || '').slice(0, 500) || undefined } }).catch(() => {});
  res.json({ ok: true });
});

export default router;

import { Router, Request, Response } from 'express';
import { onCatalogChange } from '../lib/displayEvents';

const router = Router();

/**
 * PUBLIC catalog-change signal stream (SSE). Each browser opens one of these for
 * its active branch; when any reference catalog (price list, referral-doctor /
 * diagnostic-centre / external-lab dropdowns, clinical definitions) is edited, the
 * server pushes {"catalog":"<name>"} and the client refetches just that cached
 * list. Carries only the signal — never any data — so it needs no auth (same as
 * the display stream; EventSource can't send an Authorization header anyway).
 * Heartbeat keeps idle connections alive through proxies; cleanup on disconnect.
 *
 *   GET /api/events/:branchId/catalog-stream
 */
router.get('/:branchId/catalog-stream', (req: Request, res: Response) => {
  const branchId = String(req.params.branchId || '');
  if (!branchId) {
    res.status(400).end();
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const unsubscribe = onCatalogChange(branchId, (catalog) => {
    res.write(`data: ${JSON.stringify({ catalog })}\n\n`);
    (res as any).flush?.();
  });
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
    (res as any).flush?.();
  }, 25000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

export default router;

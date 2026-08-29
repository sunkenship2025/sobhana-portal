/**
 * In-process bus that lets a queue mutation wake up the waiting-room displays.
 *
 * The staff "call next / complete" write (clinicVisits.ts) calls
 * `emitBranchChange(branchId)`; every open SSE stream for a screen in that branch
 * re-sends its state instantly. Event name = branchId, so a change only wakes the
 * screens that care.
 *
 * ponytail: single-instance only — the emitter and the SSE connection must share
 * one Node process, which they do on Render (1 instance). If this ever scales to
 * multiple instances, swap this for Redis pub/sub (already a dependency) or
 * Postgres LISTEN/NOTIFY — same two functions, different transport.
 */
import { EventEmitter } from 'events';

const emitter = new EventEmitter();
// One listener per open display. Keep a generous but FINITE cap (not 0/unlimited)
// so a genuine per-connection listener leak still trips MaxListenersExceededWarning
// instead of accumulating silently — the canary that would have surfaced the SSE
// /stream close-race leak. 500 is well above real concurrent-screen count.
emitter.setMaxListeners(500);

export function emitBranchChange(branchId: string): void {
  emitter.emit(branchId);
}

/** Subscribe a screen's stream; returns an unsubscribe to call on disconnect. */
export function onBranchChange(branchId: string, fn: () => void): () => void {
  emitter.on(branchId, fn);
  return () => emitter.off(branchId, fn);
}

/**
 * Reference-catalog changes (price list, dropdowns, definitions) — a SEPARATE
 * channel from the queue events above, so clinic-visit churn never invalidates
 * cached catalogs. Payload = which catalog changed, so a client refetches only
 * that one.
 *
 * The catalogs themselves are GLOBAL rows (BillableProduct.basePriceInPaise,
 * doctors, departments…): an edit made while standing on Chintal changes what
 * every branch quotes and bills. So those fan out to `catalog:*` — every open
 * tab, whatever branch it sits on. Branch-scoping them meant a price edit left
 * the other three branches quoting the old price until the page happened to
 * remount (staleTime never refetches an idle mounted page on its own).
 *
 * The two reserved per-branch names stay on the branch channel: `worklist`
 * fires on EVERY visit write and `inbox` on every inbound message, so fanning
 * those out would turn one branch's churn into a refetch storm on all of them.
 * ponytail: same single-instance ceiling as above — Redis pub/sub if it scales.
 */
const GLOBAL_KEY = 'catalog:*';
const BRANCH_SCOPED = new Set(['worklist', 'inbox']);

export function emitCatalogChange(branchId: string, catalog: string): void {
  emitter.emit(
    BRANCH_SCOPED.has(catalog) ? `catalog:${branchId}` : GLOBAL_KEY,
    catalog,
  );
}

/** Subscribe to a branch's catalog changes (plus the global ones); unsubscribe
 *  on disconnect. */
export function onCatalogChange(
  branchId: string,
  fn: (catalog: string) => void,
): () => void {
  const key = `catalog:${branchId}`;
  emitter.on(key, fn);
  emitter.on(GLOBAL_KEY, fn);
  return () => {
    emitter.off(key, fn);
    emitter.off(GLOBAL_KEY, fn);
  };
}

/**
 * Worklist freshness, as one router-level hook instead of ~15 hand-placed emits.
 *
 * Any successful mutation on a visit can change what the Pending Results /
 * Finalized / clinic-queue lists show on somebody ELSE's screen. Signalling once
 * on the way out covers every current handler and every one added later — the
 * failure mode of per-route emits is that the next route silently forgets.
 *
 * Rides the existing catalog channel under the reserved name `worklist`; the
 * client maps that name to "refetch the open list" rather than to a cached
 * dropdown, so no new stream, frame format, or emitter is needed.
 *
 * `/results` is excluded: report autosave fires every few seconds while a tech
 * types, and no worklist shows result-entry progress — pushing there would turn
 * one tech's keystrokes into a refetch storm on every other open tab.
 */
export function emitWorklistOnMutation(
  req: { method: string; path: string; branchId?: string },
  res: { statusCode: number; on(ev: 'finish', fn: () => void): unknown },
  next: () => void,
): void {
  if (req.method !== 'GET' && !req.path.endsWith('/results')) {
    res.on('finish', () => {
      if (res.statusCode < 400 && req.branchId) {
        emitCatalogChange(req.branchId, 'worklist');
      }
    });
  }
  next();
}

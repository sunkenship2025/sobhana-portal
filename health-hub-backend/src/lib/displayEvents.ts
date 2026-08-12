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
emitter.setMaxListeners(0); // one listener per open display; never warn.

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
 * that one. Event name is `catalog:<branchId>` — a change only wakes clients on
 * that branch. Cross-branch propagation (a global product edit) rides the client
 * staleTime backstop, not this push.
 * ponytail: same single-instance ceiling as above — Redis pub/sub if it scales.
 */
export function emitCatalogChange(branchId: string, catalog: string): void {
  emitter.emit(`catalog:${branchId}`, catalog);
}

/** Subscribe to a branch's catalog changes; unsubscribe on disconnect. */
export function onCatalogChange(
  branchId: string,
  fn: (catalog: string) => void,
): () => void {
  const key = `catalog:${branchId}`;
  emitter.on(key, fn);
  return () => emitter.off(key, fn);
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

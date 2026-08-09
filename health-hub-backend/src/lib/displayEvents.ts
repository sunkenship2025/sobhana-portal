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

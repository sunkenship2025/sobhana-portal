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

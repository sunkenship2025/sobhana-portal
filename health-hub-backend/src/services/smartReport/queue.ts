/**
 * Tiny concurrency gate. A 60-visit batch finalize must not fire 60 concurrent
 * model calls and rate-limit the provider into template copy for the evening.
 * ponytail: in-process only — if the API ever runs multi-instance this needs Redis.
 */
const MAX = Number(process.env.SMART_REPORT_CONCURRENCY || 3);
let active = 0;
const waiting: (() => void)[] = [];

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX) await new Promise<void>((r) => waiting.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

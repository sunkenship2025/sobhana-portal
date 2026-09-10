/**
 * Pulse — read-only database access.
 *
 * Every Pulse query runs as `analytics_ro`: a Postgres role with SELECT on a whitelist of
 * tables, COLUMN-level grants on Patient/User, default_transaction_read_only and an 8s
 * statement_timeout. The role is the real boundary; the validator in validator.ts is belt
 * and braces on top of it. Nothing in this module can write.
 */
import { PrismaClient } from '@prisma/client';

let url = process.env.ANALYTICS_DATABASE_URL;
// A plan can fan out to dozens of small queries. Prisma's default pool (cpus*2+1) starves under
// that and every step after the first few dies with "Timed out fetching a new connection" — which
// then reads as "no data" rather than as a failure. Raise the pool and let it wait.
if (url && !/connection_limit=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'connection_limit=25&pool_timeout=20';
if (!url) {
  // Fail loudly at import time: silently falling back to the app's write-capable
  // connection would defeat the whole point of the role.
  console.warn('[pulse] ANALYTICS_DATABASE_URL not set — Pulse endpoints will refuse to run');
}
export const ro = url ? new PrismaClient({ datasources: { db: { url } } }) : null;

export type Row = Record<string, unknown>;
export interface Exec { rows?: Row[]; err?: string; truncated?: boolean; }

/** BigInt / Decimal / Date -> JSON-safe. Money stays in paise; the UI formats. */
export function normalise(rows: unknown[]): Row[] {
  return (rows as Row[]).map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'bigint') o[k] = Number(v);
      else if (v instanceof Date) o[k] = v.toISOString();
      else if (v && typeof v === 'object' && typeof (v as any).toNumber === 'function') o[k] = (v as any).toNumber();
      else o[k] = v;
    }
    return o;
  });
}

export const MAX_ROWS = 200;

/** Run tasks with bounded concurrency — the database is the scarce resource, not the CPU. */
export async function pool<T>(limit: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(tasks.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) { const n = i++; out[n] = await tasks[n](); }
  }));
  return out;
}

/** Run a SELECT on the read-only role. Never throws; errors come back as a string. */
export async function query(sql: string, params: unknown[] = [], limit = MAX_ROWS): Promise<Exec> {
  if (!ro) return { err: 'analytics database not configured' };
  try {
    const rows = await ro.$queryRawUnsafe(sql, ...params);
    const out = normalise(rows as unknown[]);
    return { rows: out.length > limit ? out.slice(0, limit) : out, truncated: out.length > limit };
  } catch (e: any) {
    const msg = String(e?.message || e).split('\n').filter(Boolean).pop() || 'query failed';
    return { err: msg.slice(0, 160) };
  }
}

/** Today's calendar date in IST as YYYY-MM-DD. All period maths is done on these strings. */
export function todayIST(): string {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export const IST = `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'`;

/** Hinglish only when the question itself carries Roman-script Hindi; otherwise English. */
export const langOf = (q: string) => /\b(kitn[ae]|kaisa|kaise|kyun|kya|hai|hain|raha|rahi|rahe|mahine|mahina|hafte|hafta|bhi|nahi|zyada|kam|chal|kar|dena|aaya|aaye|gir|badh|paisa|kamai|bacha|nuksan|kharcha|baaki|kal|abhi|sab|theek)\b/i.test(q) ? 'Hinglish' : 'English';

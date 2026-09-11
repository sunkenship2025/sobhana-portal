/**
 * Pulse — STATUS and DIAGNOSE. "How is the business doing" / "why is collection down" are not
 * text-to-SQL questions: they need ~20 queries, a baseline, and attribution. Every query here
 * is generated deterministically from the registry — the model never writes SQL, it narrates.
 */
import { query, todayIST, IST, langOf, pool } from './db';
import { METRICS, FROMS, DIMS, dimJoin, dimOk, TEST_BRANCHES } from './catalog';
import { llmJson } from './llm';

const rupees = (v: number) => '₹' + (Math.round(v) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const fmt = (v: number | null | undefined, u?: string | null) => v == null ? '—' : u === 'paise' ? rupees(v) : u === 'ratio' ? (v * 100).toFixed(1) + '%' : u === 'minutes' ? `${Math.round(v / 60)}h` : Number(v).toLocaleString('en-IN');

export async function scalar(metric: string, from: string, to: string, extraJoin = '', dimExpr: string | null = null, where: string[] = []): Promise<any> {
  const M = METRICS[metric], F = FROMS[metric]; if (!M || !F) return null;
  const [fromClause, timeCol] = F; const w: string[] = [...where]; if (M.filt) w.push(M.filt);
  // Kidcare branches are test entries, not trade. Hiding them from a CHART was not enough — they
  // were still being summed into every total, so "this month's revenue" carried test money.
  // Excluded unless the caller named a branch, in which case it was asked for deliberately.
  if (/"Branch"\s+br\b/.test(fromClause + extraJoin) && !where.some((c) => /br\."?code"?/i.test(c))) {
    w.push(`br.code NOT IN (${TEST_BRANCHES.map((b) => `'${b}'`).join(', ')})`);
  }
  if (timeCol) { w.push(`(${timeCol} ${IST}) >= '${from}'`); w.push(`(${timeCol} ${IST}) < '${to}'`); }
  const sel = dimExpr ? `${dimExpr} AS k, ${M.sql} AS v` : `${M.sql} AS v`;
  const ex = await query(`SELECT ${sel} FROM ${fromClause}${extraJoin}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}${dimExpr ? ' GROUP BY 1' : ''}`);
  if (ex.err || !ex.rows) return null;
  return dimExpr ? ex.rows.map((r) => ({ k: String(r.k ?? '(none)'), v: Number(r.v ?? 0) })) : Number(ex.rows[0]?.v ?? 0);
}
export interface Period { from: string; to: string; }
const dstr = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const addDays = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return dstr(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };

/** Is this period unusual, or normal variation? One prior period cannot tell you. */
export async function baseline(metric: string, cur: Period, periodsBack = 8, lengthDays = 7) {
  const wins: { from: string; to: string }[] = []; let to = cur.from;
  for (let i = 0; i < periodsBack; i++) { const from = addDays(to, -lengthDays); wins.unshift({ from, to }); to = from; }
  // One bucketed query for the whole history — eight round-trips per metric was the single
  // biggest source of latency, and with several metrics it exhausted the connection pool.
  const hist = await historyBuckets(metric, wins);
  if (hist.length < 3) return null;
  const vals = hist.map((h) => h.v); const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 0;
  const now = await scalar(metric, cur.from, cur.to); const z = sd ? (now - mean) / sd : 0;
  const n = vals.length, xs = vals.map((_, i) => i), mx = (n - 1) / 2;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (vals[i] - mean), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
  return { metric, current: now, baselineMean: Math.round(mean), baselineSd: Math.round(sd), z: Number(z.toFixed(2)), periodsCompared: hist.length, periodLengthDays: lengthDays,
    trendPctPerPeriod: mean ? Number((slope / mean * 100).toFixed(1)) : null, verdict: Math.abs(z) < 1.5 ? 'within normal range' : z <= -1.5 ? 'genuinely below normal' : 'genuinely above normal' };
}

/** All windows of a metric in ONE query, bucketed by the window each row falls into. */
async function historyBuckets(metric: string, wins: { from: string; to: string }[]): Promise<{ from: string; to: string; v: number }[]> {
  const M = METRICS[metric], F = FROMS[metric];
  if (!M || !F || !F[1]) return [];
  const w: string[] = []; if (M.filt) w.push(M.filt);
  w.push(`(${F[1]} ${IST}) >= '${wins[0].from}'`); w.push(`(${F[1]} ${IST}) < '${wins[wins.length - 1].to}'`);
  const cases = wins.map((x, i) => `WHEN (${F[1]} ${IST}) >= '${x.from}' AND (${F[1]} ${IST}) < '${x.to}' THEN ${i}`).join(' ');
  const ex = await query(`SELECT (CASE ${cases} END) b, ${M.sql} v FROM ${F[0]} WHERE ${w.join(' AND ')} GROUP BY 1`, [], 100);
  if (ex.err || !ex.rows) return [];
  const by = new Map<number, number>(); for (const r of ex.rows) if (r.b !== null) by.set(Number(r.b), Number(r.v));
  return wins.map((x, i) => ({ ...x, v: by.get(i) ?? 0 })).filter((_, i) => by.has(i));
}

/** Decompose a metric's movement across every dimension it supports; rank by |contribution|. */
export function windowLabel(cur: { from: string; to: string }, partial?: boolean): string {
  const last = addDays(cur.to, -1);
  if (cur.from === last) return cur.from;
  return `${cur.from}..${last}${partial ? ' (today not counted — the period is still running)' : ''}`;
}

export function periods(kind: string, today = todayIST()) {
  const [Y, M, D] = today.split('-').map(Number);
  const k0 = String(kind || 'month').toLowerCase().trim().replace(/[\s_]+/g, '-');
  // Accept the shapes an analyst actually writes; anything unrecognised falls back to
  // month-to-date rather than producing NaN dates and an empty result nobody can explain.
  if (k0 === 'today') { return { cur: { from: today, to: addDays(today, 1) }, prev: { from: addDays(today, -1), to: today }, partial: true, days: 1, note: 'today vs yesterday' }; }
  if (k0 === 'yesterday') { const y = addDays(today, -1); return { cur: { from: y, to: today }, prev: { from: addDays(y, -1), to: y }, partial: false, days: 1, note: 'yesterday vs the day before' }; }
  if (k0 === 'last-month' || k0 === 'previous-month') { const pm = M === 1 ? 12 : M - 1, py = M === 1 ? Y - 1 : Y; kind = `${py}-${String(pm).padStart(2, '0')}`; }
  else if (k0 === 'this-month' || k0 === 'month-to-date' || k0 === 'mtd') kind = 'month';
  else if (k0 === 'last-week' || k0 === 'this-week' || k0 === 'week-to-date') kind = 'week';
  else if (/^last-(\d+)-days?$/.test(k0)) { const n = Math.min(Number(k0.match(/\d+/)![0]), 180); const from = addDays(today, -n); return { cur: { from, to: today }, prev: { from: addDays(from, -n), to: from }, partial: false, days: n, note: `trailing ${n} days vs the ${n} before` }; }
  else if (/^last-(\d+)-months?$/.test(k0)) { const n = Math.min(Number(k0.match(/\d+/)![0]), 24); const sm = ((M - n - 1) % 12 + 12) % 12 + 1, sy = Y + Math.floor((M - n - 1) / 12); const from = dstr(sy, sm, 1), to = dstr(Y, M, 1); const pn = dstr(sy - (sm - n <= 0 ? 1 : 0), ((sm - n - 1) % 12 + 12) % 12 + 1, 1); return { cur: { from, to }, prev: { from: pn, to: from }, partial: false, days: n * 30, note: `${n} whole months vs the ${n} before` }; }
  else if (k0 !== 'month' && k0 !== 'week' && !/^\d{4}-\d{2}$/.test(k0)) kind = 'month';
  if (kind === 'week') { const curFrom = addDays(today, -7); return { cur: { from: curFrom, to: today }, prev: { from: addDays(curFrom, -7), to: curFrom }, partial: false, days: 7, note: 'trailing 7 days vs the 7 before' }; }
  if (kind === 'month') {
    const elapsed = Math.max(D - 1, 1); const curFrom = dstr(Y, M, 1);
    const pm = M === 1 ? 12 : M - 1, py = M === 1 ? Y - 1 : Y; const prevFrom = dstr(py, pm, 1);
    return { cur: { from: curFrom, to: today }, prev: { from: prevFrom, to: addDays(prevFrom, elapsed) }, partial: true, days: elapsed, note: `month-to-date: first ${elapsed} days of each month, like for like` };
  }
  const [y, m] = kind.split('-').map(Number);
  const curFrom = dstr(y, m, 1), curTo = dstr(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1);
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  return { cur: { from: curFrom, to: curTo }, prev: { from: dstr(py, pm, 1), to: curFrom }, partial: false, days: 30, note: 'full calendar month vs the previous full month' };
}

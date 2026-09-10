/**
 * Pulse — STATUS and DIAGNOSE. "How is the business doing" / "why is collection down" are not
 * text-to-SQL questions: they need ~20 queries, a baseline, and attribution. Every query here
 * is generated deterministically from the registry — the model never writes SQL, it narrates.
 */
import { query, todayIST, IST, langOf } from './db';
import { METRICS, FROMS, DIMS, DIMJOIN, dimOk } from './catalog';
import { llmJson } from './llm';
import type { Route } from './router';

const rupees = (v: number) => '₹' + (Math.round(v) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const fmt = (v: number | null | undefined, u?: string | null) => v == null ? '—' : u === 'paise' ? rupees(v) : u === 'ratio' ? (v * 100).toFixed(1) + '%' : u === 'minutes' ? `${Math.round(v / 60)}h` : Number(v).toLocaleString('en-IN');

async function scalar(metric: string, from: string, to: string, extraJoin = '', dimExpr: string | null = null): Promise<any> {
  const M = METRICS[metric], F = FROMS[metric]; if (!M || !F) return null;
  const [fromClause, timeCol] = F; const w: string[] = []; if (M.filt) w.push(M.filt);
  if (timeCol) { w.push(`(${timeCol} ${IST}) >= '${from}'`); w.push(`(${timeCol} ${IST}) < '${to}'`); }
  const sel = dimExpr ? `${dimExpr} AS k, ${M.sql} AS v` : `${M.sql} AS v`;
  const ex = await query(`SELECT ${sel} FROM ${fromClause}${extraJoin}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}${dimExpr ? ' GROUP BY 1' : ''}`);
  if (ex.err || !ex.rows) return null;
  return dimExpr ? ex.rows.map((r) => ({ k: String(r.k ?? '(none)'), v: Number(r.v ?? 0) })) : Number(ex.rows[0]?.v ?? 0);
}
export interface Period { from: string; to: string; }
export interface Kpi { metric: string; unit: string; current: number; previous: number; deltaPct: number | null; direction: string; }

export async function status(cur: Period, prev: Period, metrics = ['revenue', 'visits', 'test_orders', 'reports_finalized', 'net_billed', 'discount_total']): Promise<Kpi[]> {
  const pairs = await Promise.all(metrics.map((m) => Promise.all([scalar(m, cur.from, cur.to), scalar(m, prev.from, prev.to)])));
  const out: Kpi[] = [];
  metrics.forEach((m, i) => {
    const [a, b] = pairs[i]; if (a === null || b === null) return;
    const delta = b === 0 ? null : (a - b) / Math.abs(b) * 100;
    out.push({ metric: m, unit: METRICS[m].u, current: a, previous: b, deltaPct: delta === null ? null : Number(delta.toFixed(1)), direction: delta === null ? 'n/a' : delta > 2 ? 'up' : delta < -2 ? 'down' : 'flat' });
  });
  return out;
}
const dstr = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const addDays = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return dstr(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); };

/** Is this period unusual, or normal variation? One prior period cannot tell you. */
export async function baseline(metric: string, cur: Period, periodsBack = 8, lengthDays = 7) {
  const wins: { from: string; to: string }[] = []; let to = cur.from;
  for (let i = 0; i < periodsBack; i++) { const from = addDays(to, -lengthDays); wins.unshift({ from, to }); to = from; }
  const vs = await Promise.all(wins.map((w) => scalar(metric, w.from, w.to)));
  const hist = wins.map((w, i) => ({ ...w, v: vs[i] })).filter((h) => h.v !== null) as { from: string; to: string; v: number }[];
  if (hist.length < 3) return null;
  const vals = hist.map((h) => h.v); const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 0;
  const now = await scalar(metric, cur.from, cur.to); const z = sd ? (now - mean) / sd : 0;
  const n = vals.length, xs = vals.map((_, i) => i), mx = (n - 1) / 2;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (vals[i] - mean), 0) / (xs.reduce((a, x) => a + (x - mx) ** 2, 0) || 1);
  return { metric, current: now, baselineMean: Math.round(mean), baselineSd: Math.round(sd), z: Number(z.toFixed(2)), periodsCompared: hist.length, periodLengthDays: lengthDays,
    trendPctPerPeriod: mean ? Number((slope / mean * 100).toFixed(1)) : null, verdict: Math.abs(z) < 1.5 ? 'within normal range' : z <= -1.5 ? 'genuinely below normal' : 'genuinely above normal' };
}

/** Decompose a metric's movement across every dimension it supports; rank by |contribution|. */
export async function diagnose(metric: string, cur: Period, prev: Period) {
  const total: any = { current: await scalar(metric, cur.from, cur.to), previous: await scalar(metric, prev.from, prev.to) };
  total.delta = (total.current ?? 0) - (total.previous ?? 0);
  total.deltaPct = total.previous ? Number((total.delta / Math.abs(total.previous) * 100).toFixed(1)) : null;
  const breakdowns: { dimension: string; top: any[] }[] = [];
  const dims = Object.entries(DIMS).filter(([dim]) => dimOk(metric, dim));
  const results = await Promise.all(dims.map(([dim, expr]) => { const join = DIMJOIN[dim] || ''; return Promise.all([scalar(metric, cur.from, cur.to, join, expr), scalar(metric, prev.from, prev.to, join, expr)]); }));
  for (let i = 0; i < dims.length; i++) {
    const [dim] = dims[i]; const [a, b] = results[i];
    if (!a || !b) continue;
    const pm = new Map<string, number>(b.map((r: any) => [r.k, r.v]));
    const rows = a.map((r: any) => ({ k: r.k, current: r.v, previous: pm.get(r.k) ?? 0, delta: r.v - (pm.get(r.k) ?? 0) }));
    for (const [k, v] of pm) if (!a.find((r: any) => r.k === k)) rows.push({ k, current: 0, previous: v, delta: -v });
    rows.sort((x: any, y: any) => Math.abs(y.delta) - Math.abs(x.delta));
    const share = total.delta ? (r: any) => Number((r.delta / total.delta * 100).toFixed(1)) : () => null;
    breakdowns.push({ dimension: dim, top: rows.slice(0, 5).map((r: any) => ({ ...r, shareOfChangePct: share(r) })) });
  }
  return { metric, unit: METRICS[metric]?.u, total, breakdowns };
}

/** Deterministic period resolution on IST calendar-day strings — never Date/toISOString. */
export function periods(kind: string, today = todayIST()) {
  const [Y, M, D] = today.split('-').map(Number);
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

export interface DiagAnswer { kind: 'status' | 'diagnose'; text: string; period: string; window: any; kpis?: Kpi[]; metric?: string | null; unit?: string | null; total?: any; movers?: { name: string; delta: number; share: number | null; by: string }[]; premiseCorrected?: boolean; baseline?: any; }

export async function runDiagnostic(q: string, r: Route, state: { metric?: string | null; period?: string | null } = {}, followUp = false): Promise<DiagAnswer> {
  const metric = r.metric || (followUp ? state.metric : null) || null;
  const period = /\b(week|month|hafte|mahine|last|previous|pichh?le)\b|20\d\d-\d\d/i.test(q) || !followUp ? r.period : (state.period || r.period);
  const P = periods(period);
  if (r.mode === 'STATUS') {
    const kpis = await status(P.cur, P.prev);
    const payload = { LANGUAGE: langOf(q), period, window: P, comparison: P.note, kpis: kpis.map((k) => ({ metric: k.metric, now: fmt(k.current, k.unit), before: fmt(k.previous, k.unit), changePct: k.deltaPct, direction: k.direction })) };
    const out = await llmJson<{ answer?: string }>(NARRATE, JSON.stringify(payload), { maxTokens: 500 });
    return { kind: 'status', text: out.answer || '', period, window: P, kpis };
  }
  let m = metric, premiseHolds = true, kpis: Kpi[] | undefined;
  if (!m) {
    kpis = await status(P.cur, P.prev);
    const moved = kpis.filter((k) => k.deltaPct !== null);
    const wantDown = /\b(down|drop|fell|decline|lower|worse|slump|slow|loss|nuksan|kam|gir)\b/i.test(q), wantUp = /\b(up|grew|growth|rose|increase|higher|better|spike|zyada|badh)\b/i.test(q);
    let pool = moved; if (wantDown) pool = moved.filter((k) => (k.deltaPct as number) < 0); else if (wantUp) pool = moved.filter((k) => (k.deltaPct as number) > 0);
    if (!pool.length) { pool = moved; premiseHolds = false; }
    m = pool.sort((a, b) => Math.abs(b.deltaPct as number) - Math.abs(a.deltaPct as number))[0]?.metric || 'revenue';
  } else {
    // a metric was named with an asserted direction — check the direction actually happened
    const wantDown = /\b(down|drop|fell|decline|lower|worse|slump|slow|loss|nuksan|kam|gir)\b/i.test(q), wantUp = /\b(up|grew|growth|rose|increase|higher|better|spike|zyada|badh)\b/i.test(q);
    const [a, b] = await Promise.all([scalar(m, P.cur.from, P.cur.to), scalar(m, P.prev.from, P.prev.to)]);
    if (a !== null && b !== null && b !== 0) { const d = (a - b) / Math.abs(b) * 100; if ((wantDown && d > 0) || (wantUp && d < 0)) premiseHolds = false; }
  }
  const d = await diagnose(m, P.cur, P.prev);
  const base = await baseline(m, P.cur, 8, period === 'week' ? 7 : period === 'month' ? P.days || 9 : 30);
  const payload = { LANGUAGE: langOf(q), period, window: P, comparison: P.note, metric: m, now: fmt(d.total.current, d.unit), before: fmt(d.total.previous, d.unit), changePct: d.total.deltaPct, premiseHolds,
    baseline: base ? { verdict: base.verdict, typicalForThisPeriod: fmt(base.baselineMean, d.unit), comparedAcross: `${base.periodsCompared} recent periods`, standardDeviations: base.z, underlyingTrendPctPerPeriod: base.trendPctPerPeriod } : null,
    contributors: d.breakdowns.map((b) => ({ by: b.dimension, top: b.top.slice(0, 3).map((t: any) => ({ name: t.k, change: fmt(t.delta, d.unit), shareOfChangePct: t.shareOfChangePct })) })) };
  const out = await llmJson<{ answer?: string }>(NARRATE, JSON.stringify(payload), { maxTokens: 700 });
  const movers = d.breakdowns.flatMap((b) => b.top.slice(0, 3).map((t: any) => ({ name: t.k, delta: t.delta, share: t.shareOfChangePct, by: b.dimension }))).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 6);
  return { kind: 'diagnose', text: out.answer || '', period, window: P, kpis, metric: m, unit: d.unit, total: d.total, movers, premiseCorrected: !premiseHolds, baseline: base };
}

const NARRATE = `You are a clinic analytics assistant. You are given PRE-COMPUTED facts from the database.
Write 2-4 sentences. RULES:
 · Use ONLY the numbers given. Never compute or invent a number.
 · Lead with the headline movement, then name the SPECIFIC biggest contributors by name.
 · If a baseline is given, SAY whether the movement is real or just normal variation. If the
   verdict is "within normal range", open by saying the business is tracking normally and the
   period-on-period swing is ordinary — do not dramatise it.
 · If a contributor moved against the trend, say so — that is the useful part.
 · Write in the LANGUAGE given in the input — English means plain business English, Hinglish means
   Roman-script Hindi-English. Never switch languages on your own. No SQL, no column names, no hedging.
If the comparison note says month-to-date, SAY the comparison is like-for-like so far this month.
If premiseHolds is false, the user's assumption was wrong — OPEN by correcting it plainly, then give the real picture.
Return JSON {"answer":"..."}.`;

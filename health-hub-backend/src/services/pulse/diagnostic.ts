/**
 * Pulse — STATUS and DIAGNOSE. "How is the business doing" / "why is collection down" are not
 * text-to-SQL questions: they need ~20 queries, a baseline, and attribution. Every query here
 * is generated deterministically from the registry — the model never writes SQL, it narrates.
 */
import { query, todayIST, IST, langOf, pool } from './db';
import { METRICS, FROMS, DIMS, dimJoin, dimOk } from './catalog';
import { llmJson } from './llm';
import type { Route } from './router';

const rupees = (v: number) => '₹' + (Math.round(v) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const fmt = (v: number | null | undefined, u?: string | null) => v == null ? '—' : u === 'paise' ? rupees(v) : u === 'ratio' ? (v * 100).toFixed(1) + '%' : u === 'minutes' ? `${Math.round(v / 60)}h` : Number(v).toLocaleString('en-IN');

export async function scalar(metric: string, from: string, to: string, extraJoin = '', dimExpr: string | null = null, where: string[] = []): Promise<any> {
  const M = METRICS[metric], F = FROMS[metric]; if (!M || !F) return null;
  const [fromClause, timeCol] = F; const w: string[] = [...where]; if (M.filt) w.push(M.filt);
  if (timeCol) { w.push(`(${timeCol} ${IST}) >= '${from}'`); w.push(`(${timeCol} ${IST}) < '${to}'`); }
  const sel = dimExpr ? `${dimExpr} AS k, ${M.sql} AS v` : `${M.sql} AS v`;
  const ex = await query(`SELECT ${sel} FROM ${fromClause}${extraJoin}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}${dimExpr ? ' GROUP BY 1' : ''}`);
  if (ex.err || !ex.rows) return null;
  return dimExpr ? ex.rows.map((r) => ({ k: String(r.k ?? '(none)'), v: Number(r.v ?? 0) })) : Number(ex.rows[0]?.v ?? 0);
}
export interface Period { from: string; to: string; }
export interface Kpi { metric: string; unit: string; current: number; previous: number; deltaPct: number | null; direction: string; }

export async function status(cur: Period, prev: Period, metrics = ['revenue', 'visits', 'test_orders', 'reports_finalized', 'net_billed', 'discount_total']): Promise<Kpi[]> {
  const pairs = await pool(3, metrics.map((m) => () => Promise.all([scalar(m, cur.from, cur.to), scalar(m, prev.from, prev.to)])));
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
export async function diagnose(metric: string, cur: Period, prev: Period) {
  const total: any = { current: await scalar(metric, cur.from, cur.to), previous: await scalar(metric, prev.from, prev.to) };
  total.delta = (total.current ?? 0) - (total.previous ?? 0);
  total.deltaPct = total.previous ? Number((total.delta / Math.abs(total.previous) * 100).toFixed(1)) : null;
  const breakdowns: { dimension: string; top: any[] }[] = [];
  const dims = Object.entries(DIMS).filter(([dim]) => dimOk(metric, dim));
  const results = await pool(3, dims.map(([dim, expr]) => () => { const join = dimJoin(metric, dim); return Promise.all([scalar(metric, cur.from, cur.to, join, expr), scalar(metric, prev.from, prev.to, join, expr)]); }));
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
/** The window as a human would read it. `to` is EXCLUSIVE everywhere in here, and handing the
 *  responder "2026-09-01..2026-09-11" got written up as "covering 1–11 September" when the 11th
 *  was not in the number — today's ₹15,650 was missing from a figure that claimed to include it.
 *  Whatever the window is, the label now names the last day actually counted. */
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

export interface DiagAnswer { kind: 'status' | 'diagnose' | 'advise'; findings?: { title: string; detail: string; metric?: string }[]; text: string; period: string; window: any; kpis?: Kpi[]; metric?: string | null; unit?: string | null; total?: any; movers?: { name: string; delta: number; share: number | null; by: string }[]; premiseCorrected?: boolean; baseline?: any; }

export async function runDiagnostic(q: string, r: Route, state: { metric?: string | null; period?: string | null } = {}, followUp = false): Promise<DiagAnswer> {
  const metric = r.metric || (followUp ? state.metric : null) || null;
  const period = /\b(week|month|hafte|mahine|last|previous|pichh?le)\b|20\d\d-\d\d/i.test(q) || !followUp ? r.period : (state.period || r.period);
  const P = periods(period);
  if (r.mode === 'ADVISE') {
    // Advice is not a KPI dump. Find the weak spots deterministically, then let the model
    // rank and phrase them. Every number it sees is pre-computed here.
    const kpis = await status(P.cur, P.prev);
    const rev = await diagnose('revenue', P.cur, P.prev);
    const [dueRow, lateRow, cancelRow, discRow] = await Promise.all([
      query(`SELECT COALESCE(SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise"),0)::bigint v, count(*)::int n FROM "Bill" b WHERE b."paymentStatus"<>'PAID'`),
      query(`SELECT count(*)::int v FROM "Visit" v JOIN "DiagnosticReport" dr ON dr."visitId"=v.id WHERE v."createdAt" < now() - interval '24 hours' AND v."createdAt" > now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')`),
      query(`SELECT ROUND(100.0*count(*) FILTER (WHERE o."cancelledAt" IS NOT NULL)/NULLIF(count(*),0),1) v FROM "TestOrder" o WHERE (o."createdAt" ${IST}) >= '${P.cur.from}'`),
      query(`SELECT ROUND(100.0*SUM(b."discountAmountInPaise"+b."couponDiscountInPaise")/NULLIF(SUM(b."totalAmountInPaise"),0),1) v FROM "Bill" b WHERE (b."billedAt" ${IST}) >= '${P.cur.from}'`),
    ]);
    // doctors who referred before and have gone quiet — the highest-value thing in this data
    const quiet = await query(`SELECT rd.name k, count(*)::int n FROM "ReferralDoctor_Visit" r JOIN "ReferralDoctor" rd ON rd.id=r."referralDoctorId"
      WHERE r."deletedAt" IS NULL AND (r."createdAt" ${IST}) >= '${addDays(P.cur.from, -60)}' AND (r."createdAt" ${IST}) < '${P.cur.from}'
        AND NOT EXISTS (SELECT 1 FROM "ReferralDoctor_Visit" r2 WHERE r2."referralDoctorId"=rd.id AND r2."deletedAt" IS NULL AND (r2."createdAt" ${IST}) >= '${P.cur.from}')
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
    const signals = {
      LANGUAGE: langOf(q), period, window: P, comparison: P.note,
      headline: kpis.map((k) => ({ metric: k.metric, now: fmt(k.current, k.unit), changePct: k.deltaPct })),
      moneyNotCollected: { amount: fmt(Number(dueRow.rows?.[0]?.v || 0), 'paise'), openBills: Number(dueRow.rows?.[0]?.n || 0) },
      reportsPendingOver24h: Number(lateRow.rows?.[0]?.v || 0),
      cancellationRatePct: Number(cancelRow.rows?.[0]?.v || 0),
      discountAsPctOfBilling: Number(discRow.rows?.[0]?.v || 0),
      doctorsWhoStoppedReferring: (quiet.rows || []).map((r) => ({ name: r.k, referralsInPrior60Days: Number(r.n) })),
      biggestNegativeMovers: rev.breakdowns.flatMap((b) => b.top.filter((t: any) => t.delta < 0).slice(0, 2).map((t: any) => ({ by: b.dimension, name: t.k, change: fmt(t.delta, rev.unit) }))).slice(0, 5),
    };
    const out = await llmJson<{ answer?: string; findings?: any[] }>(ADVISE_SYS, JSON.stringify(signals), { maxTokens: 800 });
    return { kind: 'advise', text: out.answer || '', period, window: P, kpis, findings: (out.findings || []).slice(0, 4) };
  }
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

const ADVISE_SYS = `A diagnostic-centre owner asked what they should DO to improve the business.
You are given SIGNALS already computed from their data. Do not restate the headline numbers as a
report — they can see those.
RULES
 · Pick the 2-4 signals that actually represent money or work being lost, and say what to do about
   each. Money sitting uncollected, reports past 24h, doctors who have stopped referring, a
   discount rate that is climbing, a branch going backwards.
 · Use ONLY the numbers given, exactly as written. Never invent or compute one.
 · Be specific and blunt: "₹4,752 is sitting unpaid across 12 bills" beats "consider following up".
 · If a signal looks healthy, do not pad the list with it. Two real things beat four vague ones.
 · Write in the LANGUAGE given. No SQL, no column names, no consultant filler.
Return JSON {"answer":"2-3 sentence opening","findings":[{"title":"<=6 words","detail":"one or two sentences, with the number"}]}.`;

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

/**
 * Pulse V2 — the analytical toolbox.
 *
 * Every tool below is DETERMINISTIC and built from the metric registry, except `query`, which
 * falls back to writing SQL for something the registry cannot express. That split is deliberate:
 * a plan of six registry tools costs zero model calls, so the analyst can afford to look at six
 * things before deciding what matters.
 */
import { query, IST, todayIST, pool } from '../db';
import { METRICS, METRIC_DIMS, DIMS, dimJoin, dimOk, FROMS } from '../catalog';
import { scalar, periods, baseline as baselineOf, addDays, fmt } from '../diagnostic';
import { generate } from '../sqlPath';
import { llmJson } from '../llm';
import { validate } from '../validator';
import { repairIdents, type Knowledge } from '../knowledge';

export interface Evidence {
  step: number; tool: string; label: string; ok: boolean; detail?: string;
  /** compact, model-facing summary — formatted strings, never raw paise */
  summary: any;
  /** full rows for the UI to render */
  data?: any;
  unit?: string | null; metric?: string | null; dimension?: string | null; period?: any;
  sql?: string; error?: string;
}

const P = (spec: string) => periods(spec || 'month');

/**
 * A filter the analyst asked for, turned into SQL — or a hard error.
 *
 * The rule that matters: a tool that cannot apply a filter must FAIL, never quietly drop it.
 * "chintal last month how many tests" once returned every branch's 14,111 and labelled it
 * Chintal. A wrong number with a confident label is the worst thing this system can do.
 */
function buildFilter(metric: string, f: any): { where: string[]; join: string } | { error: string } {
  if (!f || typeof f !== 'object' || !Object.keys(f).length) return { where: [], join: '' };
  const where: string[] = []; let join = '';
  for (const [dim, rawVal] of Object.entries(f)) {
    if (rawVal == null || rawVal === '') continue;
    if (!DIMS[dim]) return { error: `cannot filter by '${dim}' — filterable dimensions are ${Object.keys(DIMS).join(', ')}` };
    if (!dimOk(metric, dim)) return { error: `'${metric}' cannot be filtered by '${dim}'` };
    const j = dimJoin(metric, dim); if (j && !join.includes(j)) join += j;
    const vals = (Array.isArray(rawVal) ? rawVal : [rawVal]).map((v) => String(v).replace(/'/g, "''")).slice(0, 20);
    where.push(`${DIMS[dim]} IN (${vals.map((v) => `'${v}'`).join(', ')})`);
  }
  return { where, join };
}
/** Every dimension value that exists, so a filter can be checked before it silently matches nothing. */
let DIMVALS: Record<string, Set<string>> | null = null;
async function dimValues(): Promise<Record<string, Set<string>>> {
  if (DIMVALS) return DIMVALS;
  const out: Record<string, Set<string>> = {};
  const pairs: [string, string][] = [['branch', 'SELECT code v FROM "Branch"'], ['domain', `SELECT DISTINCT domain::text v FROM "Visit"`],
    ['payment_type', `SELECT DISTINCT "paymentType"::text v FROM "PaymentTransaction"`], ['payout_category', `SELECT DISTINCT "payoutCategorySnapshot" v FROM "TestOrder" WHERE "payoutCategorySnapshot" IS NOT NULL`]];
  for (const [d, sql] of pairs) { const r = await query(sql, [], 500); out[d] = new Set((r.rows || []).map((x: any) => String(x.v))); }
  DIMVALS = out; return out;
}
async function checkFilter(metric: string, f: any) {
  const built = buildFilter(metric, f);
  if ('error' in built) return built;
  const vals = await dimValues();
  for (const [dim, rawVal] of Object.entries(f || {})) {
    if (!vals[dim] || !vals[dim].size) continue;
    for (const v of (Array.isArray(rawVal) ? rawVal : [rawVal])) {
      if (v != null && v !== '' && !vals[dim].has(String(v)))
        return { error: `'${v}' is not a known ${dim}. Known values: ${[...vals[dim]].slice(0, 8).join(', ')}` };
    }
  }
  return built;
}
const U = (m: string) => METRICS[m]?.u ?? null;
export const KNOWN_METRICS = Object.keys(METRICS);
export const KNOWN_DIMS = Object.keys(DIMS);

/** metric over one period */
async function t_metric(a: any): Promise<Partial<Evidence>> {
  const m = a.metric, p = P(a.period);
  if (!METRICS[m]) return { ok: false, error: `no such metric '${m}'` };
  const f = await checkFilter(m, a.filter); if ('error' in f) return { ok: false, error: f.error };
  const v = await scalar(m, p.cur.from, p.cur.to, f.join, null, f.where);
  const scope = a.filter && Object.keys(a.filter).length ? Object.entries(a.filter).map(([k, x]) => `${k}=${x}`).join(', ') : 'all';
  return { ok: v !== null, metric: m, unit: U(m), period: p.cur, summary: { metric: m, period: `${p.cur.from}..${p.cur.to}`, scope, value: fmt(v, U(m)) }, data: { value: v } };
}
/** metric this period vs the comparable previous one */
async function t_compare(a: any): Promise<Partial<Evidence>> {
  const m = a.metric, p = P(a.period);
  if (!METRICS[m]) return { ok: false, error: `no such metric '${m}'` };
  const f = await checkFilter(m, a.filter); if ('error' in f) return { ok: false, error: f.error };
  const [now, before] = await Promise.all([scalar(m, p.cur.from, p.cur.to, f.join, null, f.where), scalar(m, p.prev.from, p.prev.to, f.join, null, f.where)]);
  if (now === null || before === null) return { ok: false, error: 'metric unavailable for that period' };
  const pct = before ? Number(((now - before) / Math.abs(before) * 100).toFixed(1)) : null;
  return { ok: true, metric: m, unit: U(m), period: p, summary: { metric: m, now: fmt(now, U(m)), before: fmt(before, U(m)), changePct: pct, comparison: p.note }, data: { now, before, changePct: pct, cur: p.cur, prev: p.prev, note: p.note } };
}
/** metric split by a dimension, with each part's share of the change */
async function t_breakdown(a: any): Promise<Partial<Evidence>> {
  const m = a.metric, d = a.dimension, p = P(a.period);
  if (!METRICS[m]) return { ok: false, error: `no such metric '${m}'` };
  if (!DIMS[d] || !dimOk(m, d)) return { ok: false, error: `'${m}' cannot be split by '${d}'. Supported: ${(METRIC_DIMS[m] || []).join(', ')}` };
  const f = await checkFilter(m, a.filter); if ('error' in f) return { ok: false, error: f.error };
  const join = dimJoin(m, d) + (f.join.includes(dimJoin(m, d)) ? '' : f.join);
  const [cur, prev] = await Promise.all([scalar(m, p.cur.from, p.cur.to, join, DIMS[d], f.where), scalar(m, p.prev.from, p.prev.to, join, DIMS[d], f.where)]);
  if (!cur) return { ok: false, error: 'no rows' };
  const pm = new Map<string, number>((prev || []).map((r: any) => [r.k, r.v]));
  const total = cur.reduce((s: number, r: any) => s + r.v, 0);
  const totalDelta = total - [...pm.values()].reduce((s, v) => s + v, 0);
  const rows = cur.map((r: any) => ({ k: r.k, v: r.v, prev: pm.get(r.k) ?? 0, delta: r.v - (pm.get(r.k) ?? 0) }));
  for (const [k, v] of pm) if (!cur.find((r: any) => r.k === k)) rows.push({ k, v: 0, prev: v, delta: -v });
  rows.sort((x: any, y: any) => y.v - x.v);
  return { ok: true, metric: m, unit: U(m), dimension: d, period: p.cur,
    summary: { metric: m, by: d, total: fmt(total, U(m)), parts: rows.slice(0, 10).map((r: any) => ({ name: r.k, value: fmt(r.v, U(m)), change: fmt(r.delta, U(m)), shareOfChangePct: totalDelta ? Number((r.delta / totalDelta * 100).toFixed(1)) : null })) },
    data: { rows, total, totalDelta } };
}
/** top-N members of a dimension by a metric */
async function t_rank(a: any): Promise<Partial<Evidence>> {
  const r = await t_breakdown({ ...a }); if (!r.ok) return r;
  const n = Math.min(Number(a.limit) || 5, 20);
  const rows = (r.data as any).rows.filter((x: any) => x.k && x.k !== '(none)').slice(0, n);
  return { ...r, summary: { metric: a.metric, by: a.dimension, top: rows.map((x: any) => ({ name: x.k, value: fmt(x.v, r.unit) })) }, data: { ...(r.data as any), rows } };
}
/** metric bucketed over time */
async function t_trend(a: any): Promise<Partial<Evidence>> {
  const m = a.metric; const F = FROMS[m]; const M = METRICS[m];
  if (!M || !F) return { ok: false, error: `no such metric '${m}'` };
  const bucket = /day/i.test(a.bucket || '') ? 'day' : /week/i.test(a.bucket || '') ? 'week' : 'month';
  const back = Math.min(Number(a.buckets) || (bucket === 'month' ? 6 : bucket === 'week' ? 8 : 30), 40);
  const today = todayIST();
  const from = bucket === 'day' ? addDays(today, -back) : bucket === 'week' ? addDays(today, -7 * back) : `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) <= back ? 1 : 0)}-${String(((Number(today.slice(5, 7)) - back + 11) % 12) + 1).padStart(2, '0')}-01`;
  const w = [`(${F[1]} ${IST}) >= '${from}'`]; if (M.filt) w.push(M.filt);
  const ex = await query(`SELECT to_char(date_trunc('${bucket}', ${F[1]} ${IST}), '${bucket === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}') k, ${M.sql} v FROM ${F[0]} WHERE ${w.join(' AND ')} GROUP BY 1 ORDER BY 1`, [], 200);
  if (ex.err || !ex.rows?.length) return { ok: false, error: ex.err || 'no rows' };
  const rows = ex.rows.map((r: any) => ({ k: String(r.k), v: Number(r.v) }));
  // The current bucket is still filling. Reporting it beside whole periods reads as a collapse —
  // it is how "revenue up 28.8%" came out as "revenue has fallen sharply". Mark it, and judge
  // direction on complete buckets only.
  const nowKey = bucket === 'month' ? today.slice(0, 7) : bucket === 'day' ? today : null;
  const partial = nowKey ? rows.findIndex((r) => r.k === nowKey) : -1;
  if (partial >= 0) (rows[partial] as any).partial = true;
  const whole = rows.filter((r: any) => !r.partial);
  const half = Math.floor(whole.length / 2) || 1;
  const first = whole.slice(0, half).reduce((s, r) => s + r.v, 0) / half, last = whole.slice(-half).reduce((s, r) => s + r.v, 0) / half;
  const lastWhole = whole[whole.length - 1];
  return { ok: true, metric: m, unit: U(m), summary: { metric: m, bucket, points: rows.length,
    from: rows[0]?.k, to: rows[rows.length - 1]?.k,
    latestComplete: lastWhole ? `${lastWhole.k}: ${fmt(lastWhole.v, U(m))}` : null,
    currentIncomplete: partial >= 0 ? `${rows[partial].k} is still in progress (${fmt(rows[partial].v, U(m))} so far) — do not compare it with whole ${bucket}s` : null,
    directionPctAcrossCompleteBuckets: first ? Number(((last - first) / Math.abs(first) * 100).toFixed(1)) : null,
    series: whole.map((r) => `${r.k}: ${fmt(r.v, U(m))}`) }, data: { rows, bucket } };
}
/** is this period unusual, or ordinary variation? */
async function t_baseline(a: any): Promise<Partial<Evidence>> {
  const m = a.metric, p = P(a.period);
  if (!METRICS[m]) return { ok: false, error: `no such metric '${m}'` };
  const b = await baselineOf(m, p.cur, 8, a.period === 'week' ? 7 : (p as any).days || 30);
  if (!b) return { ok: false, error: 'not enough history' };
  return { ok: true, metric: m, unit: U(m), summary: { metric: m, verdict: b.verdict, now: fmt(b.current, U(m)), typical: fmt(b.baselineMean, U(m)), standardDeviations: b.z, trendPctPerPeriod: b.trendPctPerPeriod }, data: b };
}
/** which headline metrics are furthest from normal */
async function t_anomaly(a: any): Promise<Partial<Evidence>> {
  const p = P(a.period);
  const list = (Array.isArray(a.metrics) && a.metrics.length ? a.metrics : ['revenue', 'visits', 'test_orders', 'outstanding', 'discount_total']).filter((m: string) => METRICS[m]).slice(0, 6);
  const out = await pool(5, list.map((m: string) => async () => {
    const b = await baselineOf(m, p.cur, 8, a.period === 'week' ? 7 : (p as any).days || 30);
    return b ? { metric: m, verdict: b.verdict, z: b.z, now: fmt(b.current, U(m)), typical: fmt(b.baselineMean, U(m)) } : null;
  }));
  const found = out.filter(Boolean).sort((x: any, y: any) => Math.abs(y.z) - Math.abs(x.z));
  return { ok: true, summary: { unusual: found.filter((f: any) => Math.abs(f.z) >= 1.5), allChecked: found.map((f: any) => f.metric) }, data: found };
}
/**
 * A metric the registry does not have, proposed as an expression over metrics it does.
 * Validated before it runs: both sides must exist, the denominator must not be a ratio,
 * and a per-unit figure must not divide money by money.
 */
async function t_derive(a: any): Promise<Partial<Evidence>> {
  const num = a.numerator, den = a.denominator, p = P(a.period);
  if (!METRICS[num]) return { ok: false, error: `numerator '${num}' is not a known metric` };
  if (!METRICS[den]) return { ok: false, error: `denominator '${den}' is not a known metric` };
  if (U(den) === 'ratio') return { ok: false, error: 'a ratio cannot be a denominator' };
  const [n, d] = await Promise.all([scalar(num, p.cur.from, p.cur.to), scalar(den, p.cur.from, p.cur.to)]);
  if (n === null || d === null) return { ok: false, error: 'one side is unavailable for that period' };
  if (!d) return { ok: false, error: `denominator '${den}' is zero for that period` };
  const v = n / d;
  const unit = U(num) === 'paise' && U(den) === 'count' ? 'paise' : U(num) === U(den) ? 'ratio' : null;
  return { ok: true, metric: `${num}_per_${den}`, unit, period: p.cur,
    summary: { derived: `${num} ÷ ${den}`, value: unit === 'paise' ? fmt(v, 'paise') : unit === 'ratio' ? (v * 100).toFixed(1) + '%' : v.toFixed(2), basis: `${fmt(n, U(num))} ÷ ${fmt(d, U(den))}` }, data: { value: v, numerator: n, denominator: d } };
}
/** anything the registry cannot express — one generated SELECT, validated like any other */
async function t_query(a: any, k: Knowledge): Promise<Partial<Evidence>> {
  const q = String(a.question || '').slice(0, 300);
  if (!q) return { ok: false, error: 'no question given' };
  const gen = await generate(k, q);
  let sql = repairIdents(k, gen.sql);
  let bad = validate(sql);
  let ex = bad ? { err: `blocked: ${bad}` } as any : await query(sql, [], 200);
  // Typed repair, one attempt — the same contract the single-call path has always had. A query
  // that errors or comes back empty is told WHICH way it failed and rewritten. Without this the
  // analyst path silently loses every question whose first draft misses.
  if (ex.err || !ex.rows?.length) {
    const kind = bad ? 'BLOCKED_BY_POLICY' : ex.err && /does not exist/.test(ex.err) ? 'MISSING_IDENTIFIER'
      : ex.err && /syntax/i.test(ex.err) ? 'SYNTAX' : ex.err ? 'RUNTIME' : 'EMPTY_RESULT';
    try {
      const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: ${kind}. ${kind === 'BLOCKED_BY_POLICY' ? 'The query violated a safety rule; rewrite it to satisfy the rule.' : kind === 'EMPTY_RESULT' ? 'It ran but matched nothing — the filter, the period or the join is probably wrong.' : ''} Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}\n\nOUTCOME\n${ex.err || '0 rows'}`, { maxTokens: 900 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2)) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; } }
    } catch { /* keep the first outcome */ }
  }
  if (ex.err) return { ok: false, error: ex.err, sql };
  if (!ex.rows?.length) return { ok: false, error: 'no rows matched', sql };
  return { ok: true, sql, summary: { question: q, rowCount: ex.rows.length, rows: ex.rows.slice(0, 12) }, data: { rows: ex.rows } };
}


/* ── OPERATIONAL TOOLS ──────────────────────────────────────────────────────
   The things an owner can actually act on tomorrow morning. These are not metrics in the
   registry sense — they are states of the business — and without them "how do I improve"
   has nothing to stand on but headline growth. */

/** money already earned and not collected */
async function t_receivables(a: any): Promise<Partial<Evidence>> {
  const r = await query(`SELECT COALESCE(SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise"),0)::bigint v, count(*)::int n,
      COALESCE(SUM(CASE WHEN b."billedAt" < now() - interval '30 days' THEN b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise" ELSE 0 END),0)::bigint old
    FROM "Bill" b WHERE b."paymentStatus" <> 'PAID'`);
  if (r.err) return { ok: false, error: r.err };
  const row: any = r.rows![0];
  const byBranch = await query(`SELECT br.code k, COALESCE(SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise"),0)::bigint v
    FROM "Bill" b JOIN "Branch" br ON br.id=b."branchId" WHERE b."paymentStatus" <> 'PAID' GROUP BY 1 HAVING SUM(b."totalAmountInPaise"-b."paidAmountInPaise") > 0 ORDER BY 2 DESC`);
  return { ok: true, unit: 'paise',
    summary: { uncollected: fmt(Number(row.v), 'paise'), openBills: Number(row.n), olderThan30Days: fmt(Number(row.old), 'paise'),
      byBranch: (byBranch.rows || []).map((x: any) => ({ name: x.k, value: fmt(Number(x.v), 'paise') })) },
    data: { total: Number(row.v), bills: Number(row.n), old: Number(row.old), rows: (byBranch.rows || []).map((x: any) => ({ k: x.k, v: Number(x.v) })) } };
}
/** work sitting unfinished — reports past their turnaround, and where */
async function t_pending_reports(a: any): Promise<Partial<Evidence>> {
  const hrs = Math.min(Math.max(Number(a.hours) || 24, 1), 240);
  const r = await query(`SELECT br.code k, count(*)::int v FROM "Visit" v JOIN "Branch" br ON br.id=v."branchId"
    JOIN "DiagnosticReport" dr ON dr."visitId"=v.id
    WHERE v."createdAt" < now() - interval '${hrs} hours' AND v."createdAt" > now() - interval '30 days'
      AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')
    GROUP BY 1 ORDER BY 2 DESC`);
  if (r.err) return { ok: false, error: r.err };
  const rows = (r.rows || []).map((x: any) => ({ k: String(x.k), v: Number(x.v) }));
  const total = rows.reduce((s, x) => s + x.v, 0);
  return { ok: true, unit: 'count', dimension: 'branch',
    summary: { pendingOver: `${hrs}h`, total, window: 'last 30 days', byBranch: rows.map((x) => ({ name: x.k, value: x.v })) },
    data: { rows, total } };
}
/** referrers who used to send work and have stopped — the highest-value list in this data */
async function t_quiet_doctors(a: any): Promise<Partial<Evidence>> {
  const p = P(a.period);
  const look = Math.min(Math.max(Number(a.priorDays) || 60, 14), 365);
  const r = await query(`SELECT rd.name k, count(*)::int n, max((r."createdAt" ${IST})::date)::text last
    FROM "ReferralDoctor_Visit" r JOIN "ReferralDoctor" rd ON rd.id=r."referralDoctorId"
    WHERE r."deletedAt" IS NULL AND (r."createdAt" ${IST}) >= '${addDays(p.cur.from, -look)}' AND (r."createdAt" ${IST}) < '${p.cur.from}'
      AND NOT EXISTS (SELECT 1 FROM "ReferralDoctor_Visit" r2 WHERE r2."referralDoctorId"=rd.id AND r2."deletedAt" IS NULL AND (r2."createdAt" ${IST}) >= '${p.cur.from}')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 10`);
  if (r.err) return { ok: false, error: r.err };
  const rows = (r.rows || []).map((x: any) => ({ k: String(x.k), v: Number(x.n), last: x.last }));
  return { ok: true, unit: 'count',
    summary: { stoppedReferring: rows.length, since: p.cur.from, lookedBackDays: look,
      doctors: rows.map((x) => ({ name: x.k, referralsBefore: x.v, lastReferral: x.last })) },
    data: { rows } };
}
/** money given away or lost — discount, cancellation and refund rates against billing */
async function t_leakage(a: any): Promise<Partial<Evidence>> {
  const p = P(a.period);
  const [d, c, rf] = await Promise.all([
    query(`SELECT COALESCE(SUM(b."discountAmountInPaise"+b."couponDiscountInPaise"),0)::bigint v, COALESCE(SUM(b."totalAmountInPaise"),0)::bigint g FROM "Bill" b WHERE (b."billedAt" ${IST}) >= '${p.cur.from}' AND (b."billedAt" ${IST}) < '${p.cur.to}'`),
    query(`SELECT count(*) FILTER (WHERE o."cancelledAt" IS NOT NULL)::int c, count(*)::int t, COALESCE(SUM(o."priceInPaise") FILTER (WHERE o."cancelledAt" IS NOT NULL),0)::bigint v FROM "TestOrder" o WHERE (o."createdAt" ${IST}) >= '${p.cur.from}' AND (o."createdAt" ${IST}) < '${p.cur.to}'`),
    query(`SELECT COALESCE(SUM(orf."amountInPaise"),0)::bigint v, count(*)::int n FROM "OrderRefund" orf WHERE (orf."createdAt" ${IST}) >= '${p.cur.from}' AND (orf."createdAt" ${IST}) < '${p.cur.to}'`),
  ]);
  const dd: any = d.rows?.[0] || {}, cc: any = c.rows?.[0] || {}, rr: any = rf.rows?.[0] || {};
  const gross = Number(dd.g || 0);
  return { ok: true, unit: 'paise', period: p.cur,
    summary: { period: `${p.cur.from}..${p.cur.to}`, grossBilled: fmt(gross, 'paise'),
      discountGiven: fmt(Number(dd.v || 0), 'paise'), discountPctOfGross: gross ? Number((Number(dd.v || 0) / gross * 100).toFixed(1)) : null,
      cancelledOrders: Number(cc.c || 0), cancelledValue: fmt(Number(cc.v || 0), 'paise'), cancelRatePct: Number(cc.t) ? Number((Number(cc.c) / Number(cc.t) * 100).toFixed(1)) : null,
      refunded: fmt(Number(rr.v || 0), 'paise'), refundEvents: Number(rr.n || 0) },
    data: { discount: Number(dd.v || 0), gross, cancelledValue: Number(cc.v || 0), refunded: Number(rr.v || 0) } };
}


/**
 * WORK LISTS — the owner chasing their own patients.
 *
 * This is the one place patient-level rows leave the database, and it is deliberate: an owner
 * cannot collect a due without a name and a number. It is narrow by construction — three fixed
 * shapes, a hard row cap, owner-only at the route, and every call written to the audit log.
 * Free-text SQL still cannot reach these columns; only these queries can.
 */
const LIST_CAP = 200;
async function t_worklist(a: any): Promise<Partial<Evidence>> {
  const kind = String(a.kind || 'dues').toLowerCase();
  const limit = Math.min(Math.max(Number(a.limit) || 50, 1), LIST_CAP);
  const br = a.branch ? String(a.branch).replace(/'/g, "''") : null;
  const minP = Number(a.minAmountInPaise) || 0;
  const olderDays = Number(a.olderThanDays) || 0;

  if (kind === 'dues' || kind === 'unpaid' || kind === 'outstanding') {
    const w = [`b."paymentStatus" <> 'PAID'`, `(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise") > ${minP}`];
    if (br) w.push(`br.code = '${br}'`);
    if (olderDays) w.push(`b."billedAt" < now() - interval '${olderDays} days'`);
    const ex = await query(`SELECT p.name AS patient, p."patientNumber" AS patient_no, ph.phone,
        b."billNumber" AS bill, br.code AS branch, (b."billedAt" ${IST})::date::text AS billed_on,
        (b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise")::bigint AS due_paise
      FROM "Bill" b
      JOIN "Visit" v ON v.id = b."visitId"
      JOIN "Patient" p ON p.id = v."patientId"
      JOIN "Branch" br ON br.id = b."branchId"
      LEFT JOIN "PatientPhone" ph ON ph."patientId" = p.id
      WHERE ${w.join(' AND ')} ORDER BY ${/old|oldest|earliest|age|ageing|aging/i.test(String(a.sort || '')) ? 'b."billedAt" ASC' : /new|newest|recent|latest/i.test(String(a.sort || '')) ? 'b."billedAt" DESC' : /name/i.test(String(a.sort || '')) ? 'p.name ASC' : 'due_paise DESC'} LIMIT ${limit}`, [], LIST_CAP);
    if (ex.err) return { ok: false, error: ex.err };
    const rows = ex.rows || [];
    const total = rows.reduce((s, r: any) => s + Number(r.due_paise || 0), 0);
    return { ok: true, unit: 'paise', phi: true,
      detail: `unpaid bills${br ? ` at ${br}` : ''}${olderDays ? `, billed over ${olderDays} days ago` : ''}${minP ? `, due over ${fmt(minP, 'paise')}` : ''}, ${a.sort ? String(a.sort) : 'largest first'}, up to ${limit}`,
      summary: { list: 'patients with dues', sortedBy: a.sort || 'largest amount first', shown: rows.length, limit, totalShown: fmt(total, 'paise'),
        note: rows.length === limit ? `capped at ${limit} — ask for a branch or a minimum amount to narrow it` : 'complete list' },
      data: { rows, total } } as any;
  }
  if (kind === 'pending_reports' || kind === 'late_reports') {
    const hrs = Math.min(Math.max(Number(a.hours) || 24, 1), 720);
    const w = [`v."createdAt" < now() - interval '${hrs} hours'`, `v."createdAt" > now() - interval '60 days'`];
    if (br) w.push(`br.code = '${br}'`);
    const ex = await query(`SELECT p.name AS patient, p."patientNumber" AS patient_no, ph.phone,
        v."billNumber" AS bill, br.code AS branch, (v."createdAt" ${IST})::date::text AS registered,
        ROUND(EXTRACT(EPOCH FROM (now() - v."createdAt"))/3600)::int AS hours_waiting
      FROM "Visit" v JOIN "Patient" p ON p.id = v."patientId" JOIN "Branch" br ON br.id = v."branchId"
      JOIN "DiagnosticReport" dr ON dr."visitId" = v.id
      LEFT JOIN "PatientPhone" ph ON ph."patientId" = p.id
      WHERE ${w.join(' AND ')} AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')
      ORDER BY hours_waiting DESC LIMIT ${limit}`, [], LIST_CAP);
    if (ex.err) return { ok: false, error: ex.err };
    return { ok: true, unit: 'count', phi: true,
      summary: { list: `reports pending over ${hrs}h`, shown: (ex.rows || []).length, limit }, data: { rows: ex.rows } } as any;
  }
  if (kind === 'not_returned' || kind === 'lapsed') {
    const days = Math.min(Math.max(Number(a.days) || 90, 7), 730);
    const ex = await query(`SELECT p.name AS patient, p."patientNumber" AS patient_no, ph.phone,
        (max(v."createdAt") ${IST})::date::text AS last_visit, count(*)::int AS visits
      FROM "Visit" v JOIN "Patient" p ON p.id = v."patientId"
      LEFT JOIN "PatientPhone" ph ON ph."patientId" = p.id
      GROUP BY p.id, p.name, p."patientNumber", ph.phone
      HAVING max(v."createdAt") < now() - interval '${days} days' AND count(*) > 1
      ORDER BY count(*) DESC LIMIT ${limit}`, [], LIST_CAP);
    if (ex.err) return { ok: false, error: ex.err };
    return { ok: true, unit: 'count', phi: true,
      summary: { list: `repeat patients not seen in ${days} days`, shown: (ex.rows || []).length, limit }, data: { rows: ex.rows } } as any;
  }
  return { ok: false, error: `unknown work list '${kind}'. Available: dues, pending_reports, not_returned` };
}

export const TOOLS: Record<string, (a: any, k: Knowledge) => Promise<Partial<Evidence>>> = {
  metric: t_metric, compare: t_compare, breakdown: t_breakdown, rank: t_rank,
  trend: t_trend, baseline: t_baseline, anomaly: t_anomaly, derive: t_derive, query: t_query,
  receivables: t_receivables, pending_reports: t_pending_reports, quiet_doctors: t_quiet_doctors, leakage: t_leakage,
  worklist: t_worklist,
};

const TRANSIENT = /connection pool|timed out|ECONNRESET|terminating connection/i;
export async function runStep(step: any, i: number, k: Knowledge): Promise<Evidence> {
  const tool = String(step?.tool || '');
  const label = String(step?.label || tool);
  const fn = TOOLS[tool];
  if (!fn) return { step: i, tool, label, ok: false, summary: null, error: `unknown tool '${tool}'` };
  // Say in words what the step asked the database, so "how this was worked out" is readable
  // to someone who will never open the SQL.
  const args = step.args || {};
  const bits = [args.metric, args.dimension && `by ${args.dimension}`, args.period && `for ${args.period}`,
    args.filter && Object.keys(args.filter).length && `where ${Object.entries(args.filter).map(([x, y]) => `${x} is ${y}`).join(' and ')}`,
    args.kind, args.sort && `sorted ${args.sort}`, args.limit && `up to ${args.limit}`, args.bucket && `by ${args.bucket}`,
    args.numerator && `${args.numerator} per ${args.denominator}`, args.hours && `over ${args.hours}h`, args.days && `${args.days} days`,
    args.question && `"${String(args.question).slice(0, 90)}"`,
  ].filter(Boolean).join(', ');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fn(args, k);
      if (!r.detail && bits) (r as any).detail = bits;
      if (!r.ok && TRANSIENT.test(String(r.error || '')) && attempt === 0) { await new Promise((s) => setTimeout(s, 400)); continue; }
      return { step: i, tool, label, ok: !!r.ok, summary: r.summary ?? null, ...r } as Evidence;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (TRANSIENT.test(msg) && attempt === 0) { await new Promise((s) => setTimeout(s, 400)); continue; }
      return { step: i, tool, label, ok: false, summary: null, error: msg.slice(0, 160) };
    }
  }
  return { step: i, tool, label, ok: false, summary: null, error: 'step failed twice' };
}

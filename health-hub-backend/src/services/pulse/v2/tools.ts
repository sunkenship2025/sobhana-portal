/**
 * Pulse V2 — the analytical toolbox.
 *
 * Every tool below is DETERMINISTIC and built from the metric registry, except `query`, which
 * falls back to writing SQL for something the registry cannot express. That split is deliberate:
 * a plan of six registry tools costs zero model calls, so the analyst can afford to look at six
 * things before deciding what matters.
 */
import { query, IST, todayIST, pool } from '../db';
import { METRICS, METRIC_DIMS, DIMS, dimJoin, dimOk, FROMS, TEST_BRANCHES, isTestBranch, DUE, OWES } from '../catalog';
import { scalar, periods, baseline as baselineOf, addDays, fmt, windowLabel } from '../diagnostic';
import { generate } from '../sqlPath';
import { llmJson } from '../llm';
import { validate, type SqlPolicy } from '../validator';
import { repairIdents, resolveTerm, resolveRanked, type Knowledge } from '../knowledge';
import { verifySpec, specRepairHint, type AnalysisSpec } from './spec';
import { compileBindings, formatBindings } from './binding';

export interface Evidence {
  step: number; tool: string; label: string; ok: boolean; detail?: string;
  /** exactly what this number represents — travels with it to the response */
  means?: string;
  /** compact, model-facing summary — formatted strings, never raw paise */
  summary: any;
  /** full rows for the UI to render */
  data?: any;
  unit?: string | null; metric?: string | null; dimension?: string | null; period?: any;
  /** how long this step took, for the trace */
  ms?: number;
  sql?: string; error?: string;
  /** model calls this step actually spent — a generated query is one call plus any repairs, and
   *  counting only the generation is how a 30-call ceiling was passed at 31. */
  calls?: number;
  /** a failure this step recovered from on its own. Recovery is PROGRESS, not stagnation — a
   *  query that fails, gets told what it dropped, and comes back with the evidence has advanced
   *  the investigation. The detector needs to be able to see the difference. */
  recovered?: string;
}

/** The one projection into the writer's hands. `summary` promised "never raw paise" and
 *  t_query broke it — a bare 435854453 reached the owner as "435,854,453". Money is formatted
 *  here, once, and list rows are carried through so a list question can actually be answered. */
export function writerRows(rows: any[] | undefined, cap = 25, money?: Set<string>): any[] | undefined {
  if (!Array.isArray(rows) || !rows.length) return undefined;
  return rows.slice(0, cap).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    const n = typeof v === 'bigint' ? Number(v) : v;
    if ((!/paise/i.test(k) && !money?.has(k)) || n == null || !Number.isFinite(Number(n))) return [k, n];
    return [k.replace(/_?in_?paise|_?paise/i, '') || 'amount', fmt(Number(n), 'paise')];
  })));
}

/** Which output columns are money, read off the SQL that produced them. Column NAMES are not
 *  reliable — "netBilledAfterDiscount" is paise with nothing in the name to say so. The select
 *  item that built it does say so, because it has to reference an *InPaise column. */
export function moneyCols(sql: string, cols: string[]): Set<string> {
  const out = new Set<string>();
  for (const c of cols) {
    const m = new RegExp(`AS\\s+"?${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`, 'i').exec(sql || '');
    if (!m) continue;
    const item = sql.slice(Math.max(0, sql.lastIndexOf(',', m.index)), m.index);
    if (/InPaise/i.test(item) && !/count|::int\b/i.test(item)) out.add(c);
  }
  return out;
}

const P = (spec: string) => periods(spec || 'month');

/**
 * A filter the analyst asked for, turned into SQL — or a hard error.
 *
 * The rule that matters: a tool that cannot apply a filter must FAIL, never quietly drop it.
 * "chintal last month how many tests" once returned every branch's 14,111 and labelled it
 * Chintal. A wrong number with a confident label is the worst thing this system can do.
 */
/** A filter value may arrive as a list or as one comma-joined string. "CNT,BLN" is two branches,
 *  not a branch named "CNT,BLN" — read literally it matched nothing and the tool rejected the
 *  step. Normalised in one place so buildFilter and checkFilter cannot disagree about it. */
const filterValues = (raw: any): string[] =>
  (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean).slice(0, 20);

function buildFilter(metric: string, f: any): { where: string[]; join: string } | { error: string } {
  if (!f || typeof f !== 'object' || !Object.keys(f).length) return { where: [], join: '' };
  const where: string[] = []; let join = '';
  for (const [dim, rawVal] of Object.entries(f)) {
    if (rawVal == null || rawVal === '') continue;
    if (!DIMS[dim]) return { error: `cannot filter by '${dim}' — filterable dimensions are ${Object.keys(DIMS).join(', ')}` };
    if (!dimOk(metric, dim)) return { error: `'${metric}' cannot be filtered by '${dim}'` };
    const j = dimJoin(metric, dim); if (j && !join.includes(j)) join += j;
    const vals = filterValues(rawVal).map((v) => v.replace(/'/g, "''"));
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
    for (const v of filterValues(rawVal)) {
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
  return { ok: v !== null, metric: m, unit: U(m), period: p.cur, summary: { metric: m, period: windowLabel(p.cur, (p as any).partial), scope, value: fmt(v, U(m)) }, data: { value: v } };
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
const summedOrdersIn = (sql: string) => /SUM\s*\(\s*\w*\.?"?priceInPaise"?/i.test(sql);

/** anything the registry cannot express — one generated SELECT, validated like any other */
async function t_query(a: any, k: Knowledge, spec?: AnalysisSpec | null, policy: SqlPolicy = {}): Promise<Partial<Evidence>> {
  const q = String(a.question || '').slice(0, 300);
  if (!q) return { ok: false, error: 'no question given' };
  let recovered: string | undefined;
  let spent = 1;                       // the generation itself
  /* THE FIX THIS PHASE EXISTS FOR. The spec was resolved before any SQL existed and then thrown
     away here; the generator re-derived meaning from English and the verifier tried to recognise
     whatever came back. Phase 1 binds TIME only — the cheapest test of whether a typed binding
     survives the generator at all. */
  const bindings = compileBindings(spec);
  const gen = await generate(k, q, { bindings: formatBindings(bindings) || undefined });
  let sql = repairIdents(k, gen.sql);
  let bad = validate(sql, policy);
  let ex = bad ? { err: `blocked: ${bad}` } as any : await query(sql, [], 200);
  // The spec is a contract. A scope the analyst committed to that never reached the SQL is a
  // rejection, not a warning — this is the check that "only lab" needed.
  let check = verifySpec(spec, sql);
  if (!check.ok && !ex.err) {
    try {
      spent++; const f = await llmJson<{ sql?: string }>(`Repair PostgreSQL. The query answers a WIDER question than was asked. ${specRepairHint(check)} Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}\n\nPROBLEM\n${check.note}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy) && verifySpec(spec, s2).ok) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; check = { ok: true, missing: [] }; recovered = 'DROPPED_CONSTRAINT'; } }
    } catch { /* fall through to the rejection below */ }
    if (!check.ok) return { ok: false, sql, calls: spent, error: `dropped a constraint the owner asked for — ${check.note}` };
  }
  // Typed repair, one attempt — the same contract the single-call path has always had. A query
  // that errors or comes back empty is told WHICH way it failed and rewritten. Without this the
  // analyst path silently loses every question whose first draft misses.
  if (ex.err || !ex.rows?.length) {
    const kind = bad ? 'BLOCKED_BY_POLICY' : ex.err && /does not exist/.test(ex.err) ? 'MISSING_IDENTIFIER'
      : ex.err && /syntax/i.test(ex.err) ? 'SYNTAX' : ex.err ? 'RUNTIME' : 'EMPTY_RESULT';
    try {
      spent++; const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: ${kind}. ${kind === 'BLOCKED_BY_POLICY' ? 'The query violated a safety rule; rewrite it to satisfy the rule.' : kind === 'EMPTY_RESULT' ? 'It ran but matched nothing — the filter, the period or the join is probably wrong.' : ''} Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}\n\nOUTCOME\n${ex.err || '0 rows'}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy)) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; recovered = kind; } }
    } catch { /* keep the first outcome */ }
  }
  if (ex.err) return { ok: false, error: ex.err, sql, calls: spent };
  if (!ex.rows?.length) return { ok: false, error: 'no rows matched', sql, calls: spent };
  // A due is the computed balance, never the paymentStatus flag. The flag disagrees with the
  // arithmetic on live rows — 48 bills carry a non-PAID status while 10 actually owe anything —
  // so the wrong one overstates the debtor count nearly fivefold. This was written into the
  // conventions and the generator still reached for the flag on the next run: a prompt rule is
  // guidance, not enforcement, and money needs enforcement.
  /* Two money-grain rules that a prompt could not hold. Both were written into the conventions
     three different ways and the generator went on ignoring them, which is the lesson of this
     whole codebase: an invariant described is not an invariant enforced.

     RATE vs TOTAL. "give me cost" for one test means the per-unit rate. The generator answered
     SUM(o."priceInPaise") over 47 orders and the writer reported Rs 1,03,400 as what a single
     scan "is sold at" — the total wearing a rate's label, which is worse than the "I could not
     establish it" it replaced, because it looks like an answer.

     TEST-SCOPED MONEY. "how much has CT-BRAIN PLAIN been billed for" is the sum of ITS order
     lines, not of every bill that happened to contain one. The same question answered Rs 83,700
     and Rs 1,03,400 on consecutive runs depending on which grain the generator picked. */
  const rateQ = /\b(cost|price|rate|charge[sd]?|mrp|how much (is|does|do)|what (is|does) .* (cost|charge))\b/i.test(q)
    && !/\btotal|\bsum|\brevenue|\bcollect|\bbilled for|\ball\b/i.test(q);
  const summedOrders = () => /SUM\s*\(\s*\w*\.?"?priceInPaise"?/i.test(sql);
  if (rateQ && summedOrders()) {
    spent++;
    try {
      const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: RATE_NOT_TOTAL. The question asks what one unit COSTS, and this query sums a price across many orders — a total is not a rate. Read the per-unit rate instead: SELECT bp.name, bp.code, bp."basePriceInPaise" FROM "BillableProduct" bp WHERE bp.code = '<the test code>' (or bp.name ILIKE the test name). Do not aggregate. Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy) && !summedOrdersIn(s2)) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; recovered = 'RATE_NOT_TOTAL'; } }
    } catch { /* keep what we had */ }
  }
  // money for a NAMED test comes from that test's order lines, never from whole-bill totals
  const testScoped = (spec?.scope || []).some((c: any) => c?.dimension === 'test');
  if (testScoped && /"Bill"/.test(sql) && /b\."?(totalAmountInPaise|paidAmountInPaise)"?/i.test(sql) && !/o\."?priceInPaise"?/i.test(sql)) {
    spent++;
    try {
      const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: TEST_GRAIN. The question is about ONE test, but this sums whole-bill amounts for every bill that contained it — those bills also contain other tests. Sum that test's own order lines: SUM(o."priceInPaise") over "TestOrder" o filtered to the test, joined to "Visit" for branch. Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy) && verifySpec(spec, s2).ok) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; recovered = 'TEST_GRAIN'; } }
    } catch { /* keep what we had */ }
  }

  const duesQ = /\b(due|dues|outstanding|owes?|owing|unpaid|receivab)/i.test(q);
  const badDue = () => duesQ && /"Bill"/.test(sql) && (/"paymentStatus"/.test(sql) || !/paidAmountInPaise/.test(sql));
  if (badDue()) {
    try {
      spent++; const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: DUE_DEFINITION. A due is the arithmetic, never the status flag. Filter on (b."totalAmountInPaise" - b."discountAmountInPaise" - b."couponDiscountInPaise" - b."reversedChargeInPaise" - b."paidAmountInPaise") > 0 and remove any "paymentStatus" condition. Counting PATIENTS means COUNT(DISTINCT v."patientId") via "Visit", not a count of bills. Change nothing else. Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy) && verifySpec(spec, s2).ok) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; recovered = 'DUE_DEFINITION'; } }
    } catch { /* keep what we had */ }
  }

  // A money figure whose column name does not say "paise" cannot be formatted safely, and an
  // unformatted paise figure reaches the owner as a hundredfold overstatement. Repair once,
  // then refuse — a silently wrong rupee number is worse than no answer.
  const cols0 = Object.keys(ex.rows[0] || {});
  const unlabelled = () => /InPaise/i.test(sql) && !moneyCols(sql, Object.keys(ex.rows[0] || {})).size
    && !Object.keys(ex.rows[0] || {}).some((c) => /paise/i.test(c));
  if (unlabelled()) {
    try {
      spent++; const f = await llmJson<{ sql?: string }>(
        `Repair PostgreSQL. FAILURE CLASS: MONEY_ALIAS. The query reads paise columns but no output column is named "*_paise", so the caller cannot tell paise from rupees. Re-alias every money output column to end in "_paise", through any CTE. Change nothing else. Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}\n\nCOLUMNS\n${cols0.join(', ')}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2, policy) && verifySpec(spec, s2).ok) { const ex2 = await query(s2, [], 200); if (!ex2.err && ex2.rows?.length) { sql = s2; ex = ex2; recovered = 'MONEY_ALIAS'; } }
    } catch { /* fall through */ }
    if (unlabelled()) return { ok: false, sql, error: 'money columns are not labelled in paise, so the figure cannot be shown safely' };
  }
  return { ok: true, sql, recovered, calls: spent, summary: { question: q, rowCount: ex.rows.length,
    rows: writerRows(ex.rows, 12, moneyCols(sql, Object.keys(ex.rows[0] || {}))) }, data: { rows: ex.rows } };
}


/* ── OPERATIONAL TOOLS ──────────────────────────────────────────────────────
   The things an owner can actually act on tomorrow morning. These are not metrics in the
   registry sense — they are states of the business — and without them "how do I improve"
   has nothing to stand on but headline growth. */

/** money already earned and not collected */
async function t_receivables(a: any): Promise<Partial<Evidence>> {
  const r = await query(`SELECT COALESCE(SUM(${DUE()}),0)::bigint v, count(*)::int n,
      COUNT(DISTINCT v."patientId")::int patients,
      COALESCE(SUM(CASE WHEN b."billedAt" < now() - interval '30 days' THEN ${DUE()} ELSE 0 END),0)::bigint old
    FROM "Bill" b JOIN "Visit" v ON v.id = b."visitId" WHERE ${OWES()}`);
  if (r.err) return { ok: false, error: r.err };
  const row: any = r.rows![0];
  const byBranch = await query(`SELECT br.code k, COALESCE(SUM(${DUE()}),0)::bigint v
    FROM "Bill" b JOIN "Branch" br ON br.id=b."branchId" WHERE ${OWES()} GROUP BY 1 ORDER BY 2 DESC`);
  return { ok: true, unit: 'paise',
    summary: { uncollected: fmt(Number(row.v), 'paise'), openBills: Number(row.n), patientsOwing: Number(row.patients), olderThan30Days: fmt(Number(row.old), 'paise'),
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
    summary: { period: windowLabel(p.cur, (p as any).partial), grossBilled: fmt(gross, 'paise'),
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
    // The computed balance IS the debt. paymentStatus is a denormalised flag that disagrees with
    // it on real rows — trusting both dropped a patient who genuinely owed money, under a
    // "complete list" headline. One source of truth for money.
    const w = [`${DUE()} > ${minP}`];
    if (br) w.push(`br.code = '${br}'`);
    if (olderDays) w.push(`b."billedAt" < now() - interval '${olderDays} days'`);
    const ex = await query(`SELECT p.name AS patient, p."patientNumber" AS patient_no, ph.phone,
        b."billNumber" AS bill, br.code AS branch, (b."billedAt" ${IST})::date::text AS billed_on,
        (b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise")::bigint AS due_paise
      FROM "Bill" b
      JOIN "Visit" v ON v.id = b."visitId"
      JOIN "Patient" p ON p.id = v."patientId"
      JOIN "Branch" br ON br.id = b."branchId"
      LEFT JOIN LATERAL (SELECT phone FROM "PatientPhone" WHERE "patientId" = p.id LIMIT 1) ph ON true
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

/** Did the work actually reach the patient? Finalising a report and sending a WhatsApp were both
 *  countable; whether anyone OPENED it was not, because ReportAccessLog was never granted. The
 *  centre logs 11,628 accesses, most of them a patient following the link we sent. */
async function t_delivery(a: any): Promise<Partial<Evidence>> {
  const days = Math.min(Math.max(Number(a.days) || 30, 1), 365);
  const br = a.branch ? String(a.branch).replace(/'/g, "''") : null;
  const W = `${IST} >= CURRENT_DATE - ${days} AND ${IST} < CURRENT_DATE`;
  const brW = br ? ` AND br.code = '${br}'` : '';
  const ex = await query(`
    WITH finalized AS (
      SELECT rv.id AS rvid, br.code AS branch
      FROM "ReportVersion" rv
      JOIN "DiagnosticReport" dr ON dr.id = rv."reportId"
      JOIN "Visit" v ON v.id = dr."visitId"
      JOIN "Branch" br ON br.id = v."branchId"
      WHERE rv.status = 'FINALIZED' AND (rv."finalizedAt" ${IST}) >= CURRENT_DATE - ${days}
        AND (rv."finalizedAt" ${IST}) < CURRENT_DATE${brW}
    ), opened AS (
      SELECT DISTINCT ral."reportVersionId" AS rvid
      FROM "ReportAccessLog" ral
      WHERE ral."accessType" = 'VIEW' AND ral."accessedVia" IN ('TOKEN','PATIENT_PORTAL')
    ), sent AS (
      SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE ml.status = 'FAILED')::int failed
      FROM "MessageLog" ml WHERE (ml."createdAt" ${IST}) >= CURRENT_DATE - ${days}
        AND (ml."createdAt" ${IST}) < CURRENT_DATE
    )
    SELECT f.branch,
           COUNT(*)::int AS reports_finalized,
           COUNT(o.rvid)::int AS reports_opened_by_patient,
           ROUND(100.0 * COUNT(o.rvid) / NULLIF(COUNT(*),0), 1) AS open_rate_pct
    FROM finalized f LEFT JOIN opened o ON o.rvid = f.rvid
    GROUP BY f.branch ORDER BY reports_finalized DESC`, [], 200);
  if (ex.err) return { ok: false, error: ex.err };
  if (!ex.rows?.length) return { ok: false, error: 'no finalized reports in that window' };
  const tot = ex.rows.reduce((acc: { f: number; o: number }, r: any) => ({ f: acc.f + Number(r.reports_finalized || 0), o: acc.o + Number(r.reports_opened_by_patient || 0) }), { f: 0, o: 0 });
  return { ok: true, unit: 'count', dimension: 'branch',
    means: `reports finalised in the last ${days} whole days, and how many were opened by the patient through the link we sent`,
    detail: `report delivery, last ${days} days${br ? ` at ${br}` : ''}`,
    summary: { window: `${days} days`, finalized: tot.f, openedByPatient: tot.o,
      openRatePct: tot.f ? Number((100 * tot.o / tot.f).toFixed(1)) : null,
      stages: [{ name: 'Reports finalised', value: tot.f }, { name: 'Opened by the patient', value: tot.o }],
      byBranch: writerRows(ex.rows, 10) },
    data: { rows: ex.rows } };
}

/** Staff actions the centre already flags: edits, voids, discounts, deletions, identity changes.
 *  This is the Audit & Anomalies feed — 44k events with an actor, a role and a severity. Pulse
 *  used to answer "which staff makes most mistakes" by denying the data existed. */
async function t_anomalies(a: any): Promise<Partial<Evidence>> {
  const days = Math.min(Math.max(Number(a.days) || 30, 1), 365);
  const by = /staff|actor|who|person|user/i.test(String(a.by || 'staff')) ? 'staff' : /categ|type|kind/i.test(String(a.by)) ? 'category' : 'staff';
  const w = [`ae."occurredAt" > now() - interval '${days} days'`];
  if (a.severity) w.push(`ae.severity = '${String(a.severity).replace(/'/g, "''")}'`);
  if (a.category) w.push(`ae.category = '${String(a.category).replace(/'/g, "''")}'`);
  if (a.branch) w.push(`br.code = '${String(a.branch).replace(/'/g, "''")}'`);
  const sel = by === 'staff' ? `COALESCE(ae."actorName",'(unattributed)') AS who, ae."actorRole" AS role` : `ae.category AS who, ae.severity AS role`;
  const ex = await query(`SELECT ${sel}, COUNT(*)::int AS events,
      COUNT(*) FILTER (WHERE ae.severity='high')::int AS high,
      COUNT(*) FILTER (WHERE ae.category='money')::int AS money_events,
      SUM(COALESCE(ae."amountInPaise",0))::bigint AS amount_paise
    FROM "AnomalyEvent" ae LEFT JOIN "Branch" br ON br.id = ae."branchId"
    WHERE ${w.join(' AND ')} GROUP BY 1,2 ORDER BY events DESC LIMIT 15`, [], 200);
  if (ex.err) return { ok: false, error: ex.err };
  if (!ex.rows?.length) return { ok: false, error: 'no flagged events in that window' };
  return { ok: true, unit: 'count',
    means: `flagged actions from the Audit & Anomalies feed, last ${days} days — activity that was reviewed, not proven error`,
    detail: `anomaly events by ${by}, last ${days} days`,
    summary: { by, window: `${days} days`, rows: writerRows(ex.rows, 15) }, data: { rows: ex.rows } };
}

/**
 * What does this word mean in this business? Deterministic lookup, no model call.
 *
 * AN INDEX MISS IS NOT AN ABSENCE. This tool used to answer "not a known concept", and the
 * analyst — reasonably — turned that into "the centre has no concept called X". Asked about
 * report types the owner had just named himself, Pulse replied "No, the system has no report
 * types called 'reportable', 'bill only', or 'external'" while those exact values sat in
 * TestOrder.workflowMode across 30,247 orders. The tool said "I did not find it" and the answer
 * said "you do not have it", and nothing in between marked that as a different claim.
 *
 * So a miss now says what it actually is — a lookup that failed — names what it nearly matched,
 * and points at where the answer may still live. The catalogue is an accelerator, never the
 * authority on what exists.
 */
async function t_resolve(a: any): Promise<Partial<Evidence>> {
  const terms = (Array.isArray(a.terms) ? a.terms : [a.term ?? a.terms]).filter(Boolean).map(String).slice(0, 6);
  if (!terms.length) return { ok: false, error: 'no terms given' };
  const one = (c: any) => ({ filter: c.dimension ? { [c.dimension]: c.value } : null, value: c.value,
    means: c.meaning, from: c.source, how: c.how, confidence: Number(c.score?.toFixed?.(2) ?? c.score) });
  const found = terms.map((t: string) => {
    const committed = resolveTerm(t).map(one);
    if (committed.length) return { term: t, ...committed[0], alternatives: committed.slice(1, 3) };
    // nothing confident. Show the near misses — including per-word, because "external reports"
    // misses as a phrase while "external" lands squarely on EXTERNAL_UPLOAD.
    const near = [...resolveRanked(t), ...String(t).split(/[^A-Za-z0-9]+/).filter((w) => w.length > 2).flatMap((w) => resolveRanked(w))]
      .sort((x, y) => y.score - x.score).slice(0, 4).map(one);
    return { term: t, resolved: false,
      means: 'NOT FOUND IN THE CONCEPT INDEX. This means the lookup failed, NOT that the business lacks it. '
        + 'The index is built from data values and schema enums and is incomplete by construction. '
        + 'Before saying the centre does not have this, look in the schema and the ENUMS block yourself.',
      nearest: near };
  });
  return { ok: true, detail: terms.join(', '), summary: { resolved: found }, data: found };
}

export const TOOLS: Record<string, (a: any, k: Knowledge) => Promise<Partial<Evidence>>> = {
  metric: t_metric, compare: t_compare, breakdown: t_breakdown, rank: t_rank,
  trend: t_trend, baseline: t_baseline, anomaly: t_anomaly, derive: t_derive, query: t_query,
  receivables: t_receivables, pending_reports: t_pending_reports, quiet_doctors: t_quiet_doctors, leakage: t_leakage,
  worklist: t_worklist, resolve: t_resolve, anomalies: t_anomalies, delivery: t_delivery,
};

const TRANSIENT = /connection pool|timed out|ECONNRESET|terminating connection/i;
/** Columns that carry a branch code across the tools. `name` matters as much as `k`: breakdown
 *  keys data.rows by `k` but summary.parts by `name`, and the waterfall renders parts — so a
 *  filter that only knew `k` left JGG on the chart while appearing to work. Matching is on the
 *  VALUE being exactly a test branch code, so a doctor or test called `name` is never touched. */
const BRANCH_COL = /^(k|name|branch|branch_?code|branch_?name|code|who)$/i;

/**
 * Test branches never reach a rendered row. CENTRAL on purpose: six tools build branch-keyed
 * rows independently — breakdown, receivables, pending_reports, delivery, anomalies, worklist —
 * and fixing one of them left JGG and IDPL sitting on the next chart the owner looked at. A
 * cross-cutting rule enforced per tool is a rule every new tool re-breaks.
 *
 * Totals are untouched: they are a rounding error either way, and silently changing what a total
 * covers is worse than including it. Only SPLITS are filtered, and only when the owner did not
 * name the branch.
 */
function hideTestBranches(e: Evidence, args: any): Evidence {
  const asked = JSON.stringify(args || {}).toUpperCase();
  if (TEST_BRANCHES.some((b) => asked.includes(b))) return e;
  const out: string[] = [];
  const scrub = (rows: any): any => !Array.isArray(rows) ? rows : rows.filter((r: any) => {
    if (!r || typeof r !== 'object') return true;
    const hit = Object.entries(r).find(([c, v]) => BRANCH_COL.test(c) && isTestBranch(v));
    if (hit) out.push(String(hit[1]));
    return !hit;
  });
  const s: any = e.summary && typeof e.summary === 'object' ? { ...e.summary } : e.summary;
  if (s && typeof s === 'object') for (const key of ['parts', 'rows', 'byBranch', 'top']) if (Array.isArray(s[key])) s[key] = scrub(s[key]);
  const d: any = (e.data as any)?.rows ? { ...(e.data as any), rows: scrub((e.data as any).rows) } : e.data;
  if (!out.length) return e;
  const uniq = [...new Set(out)];
  if (s && typeof s === 'object') s.excluded = `${uniq.join(', ')} — test branches, not real trade`;
  return { ...e, summary: s, data: d,
    means: [e.means, `${uniq.join(' and ')} left out: test branches`].filter(Boolean).join(' · ') };
}

export async function runStep(step: any, i: number, k: Knowledge, spec?: AnalysisSpec | null, policy: SqlPolicy = {}): Promise<Evidence> {
  const t0 = Date.now();
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
      const r = tool === 'query' ? await t_query(args, k, spec, policy) : await fn(args, k);
      if (!r.detail && bits) (r as any).detail = bits;
      if (!r.ok && TRANSIENT.test(String(r.error || '')) && attempt === 0) { await new Promise((s) => setTimeout(s, 400)); continue; }
      return hideTestBranches({ step: i, tool, label, ok: !!r.ok, summary: r.summary ?? null, ...r, ms: Date.now() - t0 } as Evidence, step.args);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (TRANSIENT.test(msg) && attempt === 0) { await new Promise((s) => setTimeout(s, 400)); continue; }
      return { step: i, tool, label, ok: false, summary: null, error: msg.slice(0, 160) };
    }
  }
  return { step: i, tool, label, ok: false, summary: null, error: 'step failed twice' };
}

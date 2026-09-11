/**
 * Pulse — the data-question path. ONE model call writes ONE SELECT; everything around it is
 * deterministic: validator, identifier repair, typed repair on error/empty ONLY, shape
 * choice, chips from the registry, and a second independent sample on money questions.
 * Repair on a wrong-but-valid result is deliberately absent: measured net 0 three times.
 */
import { query, type Row } from './db';
import { llmJson } from './llm';
import { validate } from './validator';
import { chooseShape, guessMetric, type Shape } from './shapes';
import { METRIC_DIMS, DIM_LABEL, METRICS } from './catalog';
import { assemble, repairIdents, SYS, type Knowledge } from './knowledge';
import { langOf } from './db';

export interface Provenance { sql: string; tables: string[]; rowCount: number; assumptions?: string; repaired?: string; }
export interface Ctx { lastQ?: string | null; lastSql?: string | null; }
export interface SqlAnswer {
  kind: 'sql'; shape: Shape; rows: Row[]; metric: string | null; unit: string | null;
  chips: { label: string; q: string }[]; warning?: { kind: 'disagreement'; text: string }; provenance: Provenance;
}
const WORTH_CHECKING = /₹|revenue|collect|billing|billed|discount|refund|commission|payout|due|outstanding|profit|margin|total|sum|average|per |rate|share|top |most|highest|lowest/i;
const tablesIn = (s: string) => [...new Set([...String(s).matchAll(/(?:from|join)\s+"(\w+)"/gi)].map((m) => m[1]))];
const canon = (rows: Row[]) => rows.flatMap((r) => Object.values(r).filter((v) => typeof v === 'number')).sort((a: any, b: any) => a - b);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= Math.max(0.011, Math.abs(b[i]) * 1e-9));

export async function generate(k: Knowledge, q: string, opts: { temperature?: number; bustCache?: boolean; prev?: Ctx } = {}) {
  let ctx = assemble(k, q);
  if (opts.prev?.lastQ) {
    // A follow-up is a modification of the previous query, not a new question. Show the model
    // what it just ran; without this "i meant trajectory wise" loses the metric and the period.
    ctx = ctx.replace('\n\nQUESTION\n', `\n\nTHE PREVIOUS QUESTION IN THIS CONVERSATION\n${opts.prev.lastQ}\n` +
      (opts.prev.lastSql ? `THE QUERY THAT ANSWERED IT\n${opts.prev.lastSql}\n` : '') +
      `\nThe question below may be a FOLLOW-UP that changes one thing about that query — the grouping,\nthe period, the metric, or the shape. Keep everything it does not change. "trajectory"/"trend"\nmeans bucket the same metric over time; "rate wise" means a percentage or per-unit view.\n\nQUESTION\n`);
  }
  // 900 fits a SELECT with a GROUP BY. It does not fit the four-CTE queries the harder questions
  // need — "what were the ten quiet doctors worth before they went quiet" truncated mid-string
  // six times in one investigation, each costing a model call and a round to produce
  // "model response was not JSON". The budget was quietly deciding which questions are answerable.
  const j = await llmJson<{ sql?: string; assumptions?: string }>(SYS(), ctx, { maxTokens: 2200, ...opts });
  return { sql: repairIdents(k, j.sql || ''), assumptions: j.assumptions, ctx };
}

async function execute(k: Knowledge, q: string, gen: { sql: string; ctx: string }): Promise<{ sql: string; rows?: Row[]; err?: string; repaired?: string }> {
  let sql = gen.sql;
  let blocked = validate(sql);
  let ex = blocked ? { err: 'BLOCKED: ' + blocked } : await query(sql);
  if (ex.err || (ex.rows && ex.rows.length === 0)) {
    // typed repair — the only place a second generation may replace the first
    const kind = ex.err && /BLOCKED/.test(ex.err) ? 'BLOCKED_BY_POLICY' : ex.err && /does not exist/.test(ex.err) ? 'MISSING_IDENTIFIER'
      : ex.err && /syntax/i.test(ex.err) ? 'SYNTAX' : ex.err ? 'RUNTIME' : 'EMPTY_RESULT';
    try {
      const f = await llmJson<{ sql?: string }>(`Repair PostgreSQL. FAILURE CLASS: ${kind}. ${kind === 'BLOCKED_BY_POLICY' ? 'The query violated a safety rule; rewrite it to satisfy the rule.' : ''} Return JSON {"sql":"..."}.`,
        `${gen.ctx}\n\nSQL\n${sql}\n\nOUTCOME\n${ex.err || '0 rows'}`, { maxTokens: 2200 });
      const s2 = repairIdents(k, f.sql || '');
      if (s2 && !validate(s2)) { const ex2 = await query(s2); if (!ex2.err && ex2.rows && ex2.rows.length) return { sql: s2, rows: ex2.rows, repaired: kind }; }
    } catch { /* keep the original outcome */ }
  }
  return { sql, rows: ex.rows, err: ex.err };
}

export async function sqlAnswer(k: Knowledge, q: string, prev?: Ctx): Promise<SqlAnswer | { kind: 'error'; text: string; provenance?: Provenance }> {
  const gen = await generate(k, q, { prev });
  const r = await execute(k, q, gen);
  if (r.err) return { kind: 'error', text: r.err, provenance: { sql: r.sql, tables: tablesIn(r.sql), rowCount: 0, assumptions: gen.assumptions } };
  const rows = r.rows || [];
  const shape = chooseShape(q, rows);
  const metric = guessMetric(q);
  const unit = metric ? METRICS[metric]?.u ?? null : null;
  // Follow-ups the model proposes from THIS answer — the registry only knows which dimensions
  // exist, not that Chintal is up 35% or that one doctor carries a third of the total.
  let chips: SqlAnswer['chips'] = [];
  try {
    const preview = JSON.stringify(rows.slice(0, 8), (_k, v) => typeof v === 'bigint' ? Number(v) : v).slice(0, 700);
    const j = await llmJson<{ chips?: { label: string; q: string }[] }>(
      `You suggest the next question a diagnostic-centre owner would ask, having just seen this answer.
Return 2-4 suggestions. Each is {"label": "<= 4 words, lower case", "q": "the full question to ask"}.
RULES
 · Base them on what the RESULT actually shows — a branch that dropped, a doctor who dominates,
   a total that looks off. Generic "by branch" is only worth suggesting if nothing specific stands out.
 · Never repeat what the question already asked. Never suggest a patient list, a name or a phone number.
 · Only things this database can answer: money, visits, tests, reports, referrals, discounts, payouts.
 · Write the label in ${langOf(q)}.
Return JSON {"chips":[...]}.`,
      `QUESTION\n${q}\n\nRESULT (${rows.length} rows)\n${preview}`, { maxTokens: 260 });
    chips = (j.chips || []).filter((c) => c && typeof c.label === 'string' && typeof c.q === 'string' && c.label.length <= 28).slice(0, 4);
  } catch { /* fall through to the registry defaults */ }
  if (!chips.length) {
    if (metric && METRIC_DIMS[metric]) for (const d of METRIC_DIMS[metric].slice(0, 3)) if (!new RegExp(d.replace('_', ' ')).test(q.toLowerCase())) chips.push({ label: DIM_LABEL[d] || d, q: `${q}, ${DIM_LABEL[d] || d}` });
    if (metric && !/why|kyun/i.test(q)) chips.push({ label: 'why?', q: `why did ${q.replace(/how (much|many)/i, '').trim()} change` });
  }
  // second independent sample — only where a wrong number costs money. Marks, never repairs.
  let warning: SqlAnswer['warning'];
  if (WORTH_CHECKING.test(q) && rows.length) {
    try {
      const g2 = await generate(k, q, { temperature: 0.7, bustCache: true, prev });
      const s2 = g2.sql; if (s2 && !validate(s2)) { const ex2 = await query(s2);
        if (!ex2.err && ex2.rows && !same(canon(rows) as number[], canon(ex2.rows) as number[]))
          warning = { kind: 'disagreement', text: 'A second, independently written query returned a different answer. Worth checking before you act on this.' }; }
    } catch { /* the check is optional */ }
  }
  return { kind: 'sql', shape, rows, metric, unit, chips, warning, provenance: { sql: r.sql, tables: tablesIn(r.sql), rowCount: rows.length, assumptions: gen.assumptions, repaired: r.repaired } };
}

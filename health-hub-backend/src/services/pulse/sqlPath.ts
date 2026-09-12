/**
 * ONE model call writes ONE SELECT. Everything around it — validation, identifier repair, typed
 * repair on error or empty — belongs to whoever runs it; this only assembles the context and
 * asks. It used to be a whole answering path of its own, which is what the analyst replaced.
 */
import { llmJson } from './llm';
import { assemble, repairIdents, SYS, type Knowledge } from './knowledge';

export interface Ctx { lastQ?: string | null; lastSql?: string | null; }

export async function generate(k: Knowledge, q: string,
  opts: { temperature?: number; bustCache?: boolean; prev?: Ctx; bindings?: string } = {}) {
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
  /* The resolved contract, placed AFTER the question rather than among the schema material.
     assemble() already emits schema graph, enums, glossary, ontology, conventions, metric and
     dimension blocks, fewshots and resolveValues before the question — a binding dropped into
     the middle of that is a binding the model has every opportunity to lose. Last position, next
     to the thing it constrains.
     resolveValues() stays for now: it grounds VALUES off k.vidx, which time binding does not
     replace. Removing it in the same change would confound the measurement. */
  if (opts.bindings) ctx = `${ctx}\n\n${opts.bindings}`;
  const j = await llmJson<{ sql?: string; assumptions?: string }>(SYS(), ctx, { maxTokens: 2200, ...opts });
  return { sql: repairIdents(k, j.sql || ''), assumptions: j.assumptions, ctx };
}

/**
 * Pulse V2 — the orchestrator. plan → execute → interpret → (maybe more) → compose.
 *
 * Bounded on purpose: at most 2 rounds and 8 steps total, and the tools are deterministic, so a
 * typical question costs 3 model calls (plan, insight, respond) regardless of how many things it
 * looks at. Only "query" steps add a call each.
 */
import { ensureKnowledge, mentionsKnown } from '../knowledge';
import { pool } from '../db';
import { runStep, type Evidence } from './tools';
import { askPlan, askInsight, askResponse } from './analyst';

const MAX_STEPS = 8, MAX_ROUNDS = 2;

export interface V2Answer {
  kind: 'analysis'; goal: string; text: string; artifacts: any[]; chips: { label: string; q: string }[];
  evidence: Evidence[]; findings: any[];
  meta: { calls: number; ms: number; steps: number; rounds: number };
  state: any;
}

const ARTIFACT_TYPES = new Set(['kpi', 'kpis', 'compare', 'chart', 'breakdown', 'ranking', 'table']);

export async function analyse(q: string, state: any = {}): Promise<any> {
  const t0 = Date.now(); let calls = 0, rounds = 0;
  const k = await ensureKnowledge();
  const ctx = state?.lastQ
    ? `THE PREVIOUS QUESTION IN THIS CONVERSATION\n${state.lastQ}\n`
      + (state.lastPlan?.length ? `THE PREVIOUS PLAN (reissue it with the change applied)\n${JSON.stringify(state.lastPlan)}\n` : '')
      + `The question below may be a follow-up that changes one thing about that — the order, the period,\nthe branch, how many rows. Keep everything it does not change.\n\n`
    : '';

  const plan = await askPlan(q, ctx); calls++;
  if (plan.phi) return { kind: 'refuse', reason: 'patient_level',
    text: "I can give you totals and counts, never a list of patients with names or phone numbers — Pulse has no access to those columns. For a working list, open Money → Bills and filter; it has the names, numbers and amounts, and it can be exported.",
    chips: [{ label: 'total due', q: 'total due how much' }, { label: 'due branch wise', q: 'due branch wise' }], state: { ...state, lastQ: q } };
  if (plan.outOfScope && !mentionsKnown(k, q)) return { kind: 'refuse', reason: 'out_of_scope',
    text: plan.why || "I can't see that — only what happens inside your centre is recorded. I didn't run a query, so there's no number to give you.",
    chips: [{ label: 'patients not back in 90 days', q: 'how many patients have not returned in 90 days' }, { label: 'new patients this month', q: 'new patients this month' }], state: { ...state, lastQ: q } };

  let steps = (plan.steps || []).slice(0, 6);
  // A registry tool computes one fixed thing. If it is the ONLY step and the question carries a
  // qualifier its arguments cannot express, the number will be right for a different question —
  // the "Chintal billed 14,111 tests" failure. Send those to query, which sees the whole sentence.
  const QUALIFIED = /\bmedian\b|\bpercentile\b|\baverage\b|\bper\b|\bnever\b|\bmore than\b|\bat least\b|\beach\b|\bdistinct\b|\bunique\b|\bboth\b|\bwithout\b|\bexcept\b|\bonly\b|\bcame back\b|\breturn(ed)?\b|\brepeat\b|\bfirst[- ]?(ever|time|visit)\b|\bstopped\b|\bnot\b|\bno\b |\bwhich day\b|\bhighest\b.*\bday\b/i;
  const REGISTRY = new Set(['metric', 'compare', 'derive']);
  if (steps.length === 1 && REGISTRY.has(steps[0]?.tool) && QUALIFIED.test(q))
    steps = [{ tool: 'query', label: steps[0].label || 'answer the question', args: { question: q } }];
  // A single query step answers the whole question, so it gets the owner's words verbatim. The
  // analyst's paraphrase drops qualifiers ("in August", "excluding cancelled") often enough to
  // matter, and the SQL is then written for a subtly different question.
  if (steps.length === 1 && steps[0]?.tool === 'query') steps[0].args = { ...steps[0].args, question: q };
  if (!steps.length) return { kind: 'refuse', reason: 'no_plan',
    text: "I'm not sure what to measure for that. I can look at money — collection, billing, dues, discounts, payouts — or volume, referrals, reports and turnaround, and tell you why something moved.",
    chips: [{ label: 'How is the business', q: 'how is the business doing this month' }, { label: 'Where am I losing money', q: 'where am i losing money' }, { label: 'Who owes money', q: 'list of patients with dues' }],
    state: { ...state, lastQ: null } };

  const evidence: Evidence[] = [];
  let findings: any[] = [];
  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    const base = evidence.length;
    const got = await pool(3, steps.map((s, i) => () => runStep(s, base + i, k)));
    calls += got.filter((e) => e.tool === 'query').length;      // only query steps cost a call (repairs may add one more)
    evidence.push(...got);
    // A one-step plan that worked has nothing to interpret — go straight to the answer. This is
    // the common case ("last month collection how much") and it saves a whole round trip.
    if (rounds === 1 && evidence.length === 1 && evidence[0].ok) break;
    if (evidence.length >= MAX_STEPS || rounds === MAX_ROUNDS) break;
    const ins = await askInsight(q, plan.goal || '', evidence); calls++;
    findings = ins.findings || findings;
    if (ins.enough !== false || !ins.steps?.length) break;
    steps = ins.steps.slice(0, Math.max(0, MAX_STEPS - evidence.length));
    if (!steps.length) break;
  }

  const usable = evidence.filter((e) => e.ok);
  if (!usable.length) return { kind: 'refuse', reason: 'no_data',
    text: 'Nothing came back for that. If it is something the centre does not record, the answer is that we do not have it — not that it is zero.',
    provenance: { sql: evidence.find((e) => e.sql)?.sql, tables: [], rowCount: 0 }, state: { ...state, lastQ: q } };

  const res = await askResponse(q, plan.goal || '', usable, findings); calls++;
  const byIdx = new Map(evidence.map((e) => [e.step, e]));
  const artifacts = (res.artifacts || []).filter((s: any) => {
    if (!s || !ARTIFACT_TYPES.has(s.type)) return false;
    const idx = Array.isArray(s.evidence) ? s.evidence : s.evidence != null ? [s.evidence] : [];
    return idx.length > 0 && idx.every((i: any) => byIdx.get(Number(i))?.ok);   // never render a failed step
  }).slice(0, 4);
  const text = String(res.text || findings[0]?.detail || '').trim();

  return { kind: 'analysis', goal: plan.goal || '', text, artifacts, findings,
    chips: (res.suggest || []).filter((c: any) => c?.label && c?.q).slice(0, 4),
    evidence: evidence.map((e) => ({ step: e.step, tool: e.tool, label: e.label, ok: e.ok, metric: e.metric, unit: e.unit, dimension: e.dimension, summary: e.summary, data: e.data, sql: e.sql, error: e.error })),
    meta: { calls, ms: Date.now() - t0, steps: evidence.length, rounds },
    state: { ...state, lastQ: q, kind: 'analysis', lastPlan: steps.map((s: any) => ({ tool: s.tool, args: s.args })) } } as V2Answer;
}

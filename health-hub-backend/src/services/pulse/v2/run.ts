/**
 * Pulse V2 — the orchestrator. plan → execute → interpret → (maybe more) → compose.
 *
 * Bounded on purpose: at most 2 rounds and 8 steps total, and the tools are deterministic, so a
 * typical question costs 3 model calls (plan, insight, respond) regardless of how many things it
 * looks at. Only "query" steps add a call each.
 */
import { ensureKnowledge, mentionsKnown, scopeTermsIn } from '../knowledge';
import { pool } from '../db';
import { runStep, type Evidence } from './tools';
import { completeSpec, lineage, type AnalysisSpec } from './spec';
import { askPlan, askInvestigate, askResponse } from './analyst';
import { normalise, merge, resolved, openMaterial, brief, enforce, conclude, measure, stagnating, coverage,
  missingRequirements, type Investigation, type RoundProgress } from './investigation';
import { contractFor, inferJob, checkAnswer, simplify } from './contract';
import { renderOptions, describeEvidence, JOBS } from './capability';
import { buildTurnArtifacts, artifactContext, hasArtifactReference, type LastTurn } from './artifacts';
import { rank as rankOpportunities, honestImpact } from './opportunity';
import { groundNumbers } from './grounding';

/* Limits are a safety net against unproductive wandering, not a latency ceiling. A hard stop at
   3 queries produced shallow answers to questions that deserved a real investigation; the loop
   now continues while the analyst says the next step is worth taking, within a generous budget. */
// An investigation earns more time than a lookup, but the ceiling has to be real: the deadline
// used to be checked only between rounds, so a four-round investigation ran 116s against a 45s
// budget. It is now checked before dispatching any step, which is where the time actually goes.
/* EMERGENCY CEILINGS, not targets. These exist for a bug or a model that will not converge —
   they are not the analytical stopping condition, which is whether the question has actually
   been established. For money questions a defensible answer in 25 seconds beats a plausible one
   in 8, so the loop is allowed to keep going while it is closing real hypotheses; hitting one of
   these is a FAILURE mode that the answer has to disclose, not a normal finish. */
const MAX_STEPS = 40, MAX_ROUNDS = 12, MAX_MS = 180_000, MAX_CALLS = 30;
/* A cap cannot tell an investigation that is working from one that is stuck, so it punishes both.
   Asked how to grow the business, the loop spent eight rounds and fifteen query attempts on the
   two hypotheses that mattered, got one to run, and was cut off by the round count with exactly
   those two open — at 82s of a 180s budget. It did not run out of time or ideas; it ran out of
   permission while repeating a failure.
   What we actually want to stop is a loop making no progress. A round is PRODUCTIVE if it brought
   back usable evidence or settled a claim. One barren round is worth allowing — the analyst may
   change approach. Two in a row means the third will be barren too, and the honest reason is that
   we could not establish it, not that we ran out of rounds. */
/* Stagnation is judged over a window, not a single barren round: one barren round is normal,
   and stopping on it would be the cap again wearing a new hat. */
const STAGNATION_WINDOW = 3;
/* Reserved for the investigate call plus the round it would buy plus the final response. Without
   it the deadline passes at 55s, then an unbounded model call and another round run anyway. */
const ROUND_RESERVE = 30_000;
/* A query step is its own model call plus a database round trip — reckon on this much each. */
const STEP_COST = 12_000;
/* A per-step timeout was tried here and removed. It did not move the worst case at all — 114s
   with it, 114s without — because the cost is seven sequential model calls, not any one step.
   What it DID do was turn a slow-but-correct dues count into "nothing came back for that". A
   guard that cannot help but can refuse a good answer is worse than no guard. */

export interface V2Answer {
  kind: 'analysis'; goal: string; text: string; artifacts: any[]; chips: { label: string; q: string }[];
  evidence: Evidence[]; findings: any[];
  meta: { calls: number; ms: number; steps: number; rounds: number };
  state: any;
}

const ARTIFACT_TYPES = new Set(['kpi', 'kpis', 'compare', 'chart', 'breakdown', 'ranking', 'table', 'waterfall', 'distribution', 'funnel', 'pareto']);

/** What Pulse is doing, as it does it. The panel showed a canned three-line rotation on a timer
 *  with no relationship to the work, so a two-minute investigation looked like a hang. The loop
 *  already knows what it is measuring and what it has ruled out; this just says so out loud. */
export type ProgressKind = 'phase' | 'objective' | 'step' | 'confirmed' | 'rejected';
/** The UI should not have to sniff a tick out of a string to know what a line means — that is
 *  the same string-matching that this codebase spent a day removing everywhere else. */
export type Progress = (text: string, kind?: ProgressKind) => void;

export async function analyse(q: string, state: any = {}, say: Progress = () => {}): Promise<any> {
  const t0 = Date.now(); let calls = 0, rounds = 0;
  const k = await ensureKnowledge();
  const last: LastTurn | null = state?.lastTurn || null;
  const ctx = (last ? artifactContext(last) : '') + (state?.lastQ
    ? `THE PREVIOUS QUESTION IN THIS CONVERSATION\n${state.lastQ}\n`
      + (state.lastPlan?.length ? `THE PREVIOUS PLAN (reissue it with the change applied)\n${JSON.stringify(state.lastPlan)}\n` : '')
      + `The question below may be a follow-up that changes one thing about that — the order, the period,\nthe branch, how many rows. Keep everything it does not change.\n\n`
    : '');

  say('Working out what to measure', 'phase');
  const plan = await askPlan(q, ctx); calls++;
  if (plan.goal) say(String(plan.goal).slice(0, 140), 'objective');
  const spec: AnalysisSpec | null = completeSpec(plan.spec ? { goal: plan.goal || '', ...plan.spec } : null);
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
  // A qualifier the plan never carries is the silent-drop failure: "only lab" answered with the
  // total including OP fees, labelled "lab collection". Validated filters catch a WRONG filter;
  // nothing caught a MISSING one. If the question scopes it and no step does, send it to query,
  // which sees the whole sentence.
  // Any qualifier in the question the SPEC failed to capture is the silent-drop failure. Trust
  // the spec when it has one; fall back to the semantic index when the analyst wrote none.
  const declared = new Set((spec?.scope || []).map((c) => c.dimension));
  const found = scopeTermsIn(q);
  const uncaptured = found.filter((c) => c.dimension && !declared.has(c.dimension));
  const covered = (c: { dimension: string | null }) => steps.some((st: any) =>
    (c.dimension && st?.args?.filter?.[c.dimension] != null) || st?.args?.dimension === c.dimension || st?.tool === 'query');
  if (uncaptured.length && !uncaptured.every(covered))
    steps = [{ tool: 'query', label: 'answer the question as asked', args: { question: q } }];
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
  let inv: Investigation | null = null;
  const announced = new Set<string>();   // a verdict is news once, not once per round
  const seen = new Set<string>();       // evidence signatures — the same rows twice is not news
  const dims = new Set<string>();       // what has been looked at, so breadth counts as progress
  const history: RoundProgress[] = [];
  for (rounds = 1; rounds <= MAX_ROUNDS; rounds++) {
    // the deadline is checked HERE, before the work, not only after a round has already overrun
    if (rounds > 1 && Date.now() - t0 > MAX_MS) break;
    // Fan-out is bounded by the time left, not by what the analyst asked for. A round of six
    // query steps is six model calls and six round trips; asking for all of them at second 40 is
    // how a 60s budget became 130s.
    const left = MAX_MS - (Date.now() - t0);
    if (rounds > 1) steps = steps.slice(0, Math.max(1, Math.floor(left / STEP_COST)));
    // The expensive steps are the "query" ones — each writes SQL with its own model call. The
    // registry tools are deterministic and effectively free, so breadth through them is fine.
    // Round 1 takes its plan straight from the analyst and was never bounded at all: six query
    // steps is six model calls spent before any budget check gets to run.
    let budget = Math.max(1, Math.min(3, Math.floor((MAX_CALLS - calls - 2) / 1)));
    // A query step with no question cannot run; dispatching it burns a step slot and a round to
    // produce the error "no question given". The question lives in args — checking s.question
    // instead silently dropped EVERY query step, which is the same mistake as verifying a fix
    // with a probe that shares the bug.
    steps = steps.filter((s: any) => s?.tool !== 'query' || String(s?.args?.question || '').trim());
    steps = steps.filter((s: any) => s?.tool !== 'query' || budget-- > 0);
    for (const s of steps) if (s?.label) say(String(s.label).slice(0, 70), 'step');
    const base = evidence.length;
    const missingBefore = missingRequirements(inv, evidence);
    const got = await pool(3, steps.map((s, i) => () => runStep(s, base + i, k, spec)));
    for (const e of got) if (e.ok && !e.means) e.means = lineage(spec, e.detail);
    calls += got.reduce((n, e) => n + (e.calls ?? (e.tool === 'query' ? 1 : 0)), 0);   // generation AND every repair
    evidence.push(...got);
    // A one-step plan that worked has nothing to interpret — go straight to the answer. This is
    // the common case ("last month collection how much") and it saves a whole round trip.
    if (rounds === 1 && evidence.length === 1 && evidence[0].ok) break;
    if (evidence.length >= MAX_STEPS || rounds === MAX_ROUNDS || calls >= MAX_CALLS) { inv = conclude(inv, 'resource_limit'); break; }
    // Reserve enough to write the answer; otherwise keep going while something is open.
    if (Date.now() - t0 > MAX_MS - ROUND_RESERVE) { inv = conclude(inv, 'resource_limit'); break; }
    say('Checking what that rules out', 'phase');
    const ins = await askInvestigate(q, plan.goal || '', evidence, brief(inv)); calls++;
    findings = ins.findings || findings;
    const before = new Map((inv?.hypotheses || []).map((h) => [h.id, h.status]));
    inv = merge(inv, normalise(ins, plan.goal || ''));
    // THE GATE. A claim is settled only when the analysis it said it needed actually ran.
    // Without this the loop still stopped on the model's own say-so — an empty "next" is the same
    // judgment as "enough: true", just wearing a structured coat.
    const gated = enforce(inv, evidence);
    inv = gated.inv;
    for (const d of gated.downgraded) say(`Still unproven: ${inv.hypotheses.find((h) => h.id === d.id)?.claim?.slice(0, 80)}`, 'phase');
    // say what just got settled — this is the part worth watching
    for (const h of inv.hypotheses) {
      if (h.status === 'open' || before.get(h.id) === h.status) continue;
      const line = h.claim.slice(0, 110);
      if (announced.has(line)) continue;
      announced.add(line); say(line, h.status === 'confirmed' ? 'confirmed' : 'rejected');
    }
    // Continue because something MATERIAL is still open, not because the model wants to keep
    // going — and stop when nothing cheap is left that would change what the owner is told.
    if (resolved(inv)) { inv = conclude(inv, 'resolved'); break; }
    // Did this round change what we know? Not "was it allowed" — measured, and the ONLY analytical
    // reason to stop short of resolved. A question that genuinely needs thirty queries gets them.
    const p = measure({ got, seen, dims, before, missingBefore, inv, evidence });
    history.push(p);
    if (stagnating(history, STAGNATION_WINDOW)) {
      say('No longer learning anything new from this line of enquiry', 'phase');
      inv = conclude(inv, 'stagnation'); break;
    }
    let next = (Array.isArray(ins.next) ? ins.next : [])
      .filter((s: any) => s && s.tool && (!s.resolves || openMaterial(inv).some((h) => h.id === s.resolves)));
    // Nothing proposed that would resolve an open claim. Before accepting that, ask the better
    // question: not "what else could I look at" but "what evidence is still REQUIRED". Each open
    // claim already named the analysis it needs; if any of that never ran, the next step is not a
    // matter of opinion and does not need a model to invent it. This is also the only place the
    // model's silence used to end an investigation — an empty "next" is "I am done" in a
    // structured coat, and the controller, not the model, decides that.
    if (!next.length) {
      next = openMaterial(inv).flatMap((h) => coverage(h, evidence).missing.slice(0, 2)
        .map((r) => ({ tool: r.tool, label: `${r.metric || r.tool}${r.dimension ? ` by ${r.dimension}` : ''}`.slice(0, 60),
          args: { metric: r.metric, dimension: r.dimension }, resolves: h.id })))
        .slice(0, 3);
      if (next.length) say('Going after what these claims still need', 'phase');
    }
    // Genuinely the end of what we could establish — and the answer has to say so rather than
    // presenting a conclusion.
    if (!next.length) { inv = conclude(inv, 'insufficient_evidence'); break; }
    steps = next.slice(0, Math.max(0, MAX_STEPS - evidence.length));
    if (!steps.length) { inv = conclude(inv, 'resource_limit'); break; }
  }

  const usable = evidence.filter((e) => e.ok);
  if (!usable.length) return { kind: 'refuse', reason: 'no_data',
    text: 'Nothing came back for that. If it is something the centre does not record, the answer is that we do not have it — not that it is zero.',
    provenance: { sql: evidence.find((e) => e.sql)?.sql, tables: [], rowCount: 0 }, state: { ...state, lastQ: q } };

  // What kind of understanding is owed. The ANALYST declares it; if the plan came back without
  // one it is inferred from the STRUCTURE of what came back, never from the wording — that ladder
  // is what this replaced. A bare follow-up inherits the job of the turn before it.
  const structures = usable.map(describeEvidence);
  const tRender = Date.now();
  const job = (plan.job && JOBS.includes(plan.job) ? plan.job : null)
    ?? (state?.lastQ && last?.job ? last.job : null)
    ?? inferJob(structures);
  // What can truthfully be drawn from what came back — computed from the rows, not the wording.
  // A renderer whose requirements the evidence does not meet is not an option at all, which is
  // what stops a "required" waterfall from shipping with nothing in it.
  // NOT the question — a presentation the analyst resolved from it, as a renderer type.
  const options = renderOptions(usable, job, (plan as any).present);
  const allowed = options.map((o) => o.type);
  // the structure behind whatever we are most likely to show tunes the contract
  const pIdx = options.length ? usable.findIndex((e) => e.step === options[0].step) : 0;
  const contract = { ...contractFor(job, structures[pIdx >= 0 ? pIdx : 0]), canShow: allowed };

  const byIdx = new Map(evidence.map((e) => [e.step, e]));
  const keepArtifacts = (list: any[]) => (list || []).filter((a: any) => {
    if (!a || !ARTIFACT_TYPES.has(a.type)) return false;
    // A type the evidence cannot support is dropped, not merely discouraged. Asking for a
    // waterfall over rows with no deltas renders an empty card and calls itself an answer.
    if (allowed.length && !allowed.includes(String(a.type))) return false;
    const idx = Array.isArray(a.evidence) ? a.evidence : a.evidence != null ? [a.evidence] : [];
    return idx.length > 0 && idx.every((i: any) => byIdx.get(Number(i))?.ok);   // never render a failed step
  }).slice(0, 4);

  say('Writing it up', 'phase');
  /** Segments composed into one string for validation, the audit and any client that wants prose. */
  const compose = (r: any): string => [r?.verdict,
    ...(Array.isArray(r?.points) ? r.points.map((p: any) => p?.label ? `${p.label}: ${p.text}` : p?.text) : []),
    r?.caveat, r?.action].filter((x) => typeof x === 'string' && x.trim()).join(' ');

  // The single worst failure mode in the system: the whole investigation completes, the write-up
  // truncates mid-JSON, V2 throws, and V1 answers a DIFFERENT question with none of this evidence.
  // Everything above is thrown away for a formatting hiccup. One retry, told to keep it short.
  let res: any;
  try { res = await askResponse(q, plan.goal || '', usable, findings, contract, undefined, brief(inv), options); }
  catch (e: any) {
    say('Tightening the write-up', 'phase');
    res = await askResponse(q, plan.goal || '', usable, findings, contract,
      'Your last reply was cut off before it was valid JSON. Say the same thing in fewer words.',
      brief(inv), options);
    calls++;
  }
  calls++;
  let artifacts = keepArtifacts(res.artifacts || []);
  let text = String(res.text || compose(res) || findings[0]?.detail || '').trim();

  // Generate → validate → repair once → deterministic simplify. An answer that violates its
  // contract is never shipped as written: a wall of serialised rows is a wrong answer even when
  // every number in it is right.
  let repaired = false, simplified = false;
  let check = checkAnswer(contract, text, artifacts, allowed, usable);
  // what was wrong BEFORE the repair — recording the post-repair state says nothing
  const firstViolations = check.violations;
  if (!check.ok) {
    try {
      const again = await askResponse(q, plan.goal || '', usable, findings, contract, check.note, brief(inv), options); calls++;
      const a2 = keepArtifacts(again.artifacts || []), t2 = String(again.text || compose(again) || '').trim();
      repaired = true;
      if (t2 && checkAnswer(contract, t2, a2, allowed, usable).ok) { res = again; text = t2; artifacts = a2; check = { ok: true, violations: [] }; }
      else if (t2 && a2.length >= artifacts.length) { res = again; text = t2; artifacts = a2; }
    } catch { /* keep the first attempt */ }
    if (!checkAnswer(contract, text, artifacts, allowed, usable).ok) {
      // still over budget: force on the best-scoring renderer the evidence actually supports,
      // then keep the sentences carrying the conclusion and drop the ones reciting detail
      if (contract.needsArtifact && options.length && !artifacts.some((a: any) => allowed.includes(a.type))) {
        const best = options[0];
        artifacts = [{ type: best.type, label: byIdx.get(best.step)?.label || 'detail', evidence: best.step }, ...artifacts].slice(0, 4);
      }
      const simple = simplify(contract, text, artifacts);
      if (simple.dropped) { text = simple.text; simplified = true; }
    }
  }

  /**
   * Incompleteness travels as DATA, not as a sentence the writer might forget. The contract
   * violation nudges the prose, and on the run that failed the suite the prose happened to
   * disclose it — but that is luck, and the guarantee cannot depend on a regex recognising
   * whatever words the model chose. If the investigation did not close, the ANSWER is marked
   * incomplete and the panel says so, whatever the prose does.
   */
  const incomplete = inv && inv.complete === false ? {
    reason: inv.stoppingReason ?? 'insufficient_evidence',
    open: openMaterial(inv).map((h) => h.claim).slice(0, 3),
  } : null;

  const turnArtifacts = buildTurnArtifacts(artifacts, evidence);

  // THE TRACE — every decision this turn made, so the architecture can be researched rather
  // than guessed at. Everything found today came from replaying the log; the log only held
  // summaries, so each defect needed a fresh reproduction to see. This is what it should have
  // been recording all along.
  const trace = {
    v: 1,
    question: q, job, ms: Date.now() - t0, calls, rounds, steps: evidence.length,
    plan: { goal: plan.goal, job: plan.job ?? null, spec,
      proposed: (plan.steps || []).map((s: any) => ({ tool: s?.tool, label: s?.label, args: s?.args })) },
    executed: evidence.map((e) => ({ i: e.step, tool: e.tool, label: e.label, ok: e.ok, ms: e.ms ?? null,
      rows: Array.isArray((e.data as any)?.rows) ? (e.data as any).rows.length : null,
      error: e.error, recovered: e.recovered, sql: e.sql?.slice(0, 600), means: e.means })),
    investigation: inv ? { objective: inv.objective, confidence: inv.confidence,
      complete: inv.complete, stoppingReason: inv.stoppingReason, progress: history,
      hypotheses: inv.hypotheses.map((h) => ({ id: h.id, status: h.status, material: h.material, claim: h.claim })),
      unresolved: inv.unresolved, contradictions: inv.contradictions } : null,
    render: { structures: structures.map((st, i) => ({ step: usable[i]?.step, ...st })),
      admissible: options, chosen: artifacts.map((a: any) => ({ type: a.type, step: a.evidence })) },
    contract: { job: contract.job, maxNumbers: contract.maxNumbers, needsArtifact: contract.needsArtifact,
      rowsInProse: contract.rowsInProse, canShow: allowed },
    validation: { violations: firstViolations, stillBroken: checkAnswer(contract, text, artifacts, allowed, usable, brief(inv)).violations, repaired, simplified },
    // where every figure in the shipped answer came from — exact, derived, ordinary, or nowhere
    grounding: groundNumbers(text, usable).map((g) => ({ n: g.text, kind: g.provenance.kind,
      how: (g.provenance as any).how ?? (g.provenance as any).why ?? (g.provenance as any).fact?.label })),
    answer: { text, artifacts: artifacts.map((a: any) => a.type), chips: (res.suggest || []).map((c: any) => c?.label) },
    timing: { toEvidence: tRender - t0, toAnswer: Date.now() - tRender },
  };
  // the segments travel alongside the composed text, so the panel can lay them out and an older
  // client still gets a readable paragraph
  const segments = simplified ? null : { verdict: (res as any).verdict, points: (res as any).points,
    caveat: (res as any).caveat, action: (res as any).action };
  // Ranked HERE, not by the model: impact first, confidence second, and the weighting is shown
  // so the owner can disagree with the order rather than just receive it.
  const ranked = job === 'opportunity' ? rankOpportunities((res as any).opportunities || []) : null;
  const opportunities = ranked?.recommended?.map((o) => ({ ...o, impact: honestImpact(o) })) ?? null;
  // named, but never presented as advice — you may not recommend what you have not measured
  const consideredNotSized = ranked?.considered?.length ? ranked.considered.map((o) => o.title) : null;
  return { kind: 'analysis', goal: plan.goal || '', spec, job, investigation: brief(inv), trace, text, segments, incomplete, opportunities, consideredNotSized, artifacts, findings,
    chips: (res.suggest || []).filter((c: any) => c?.label && c?.q).slice(0, 4),
    evidence: evidence.map((e) => ({ step: e.step, tool: e.tool, label: e.label, ok: e.ok, metric: e.metric, unit: e.unit, dimension: e.dimension, means: e.means, detail: e.detail, summary: e.summary, data: e.data, sql: e.sql, error: e.error })),
    meta: { calls, ms: Date.now() - t0, steps: evidence.length, rounds },
    state: { ...state, lastQ: q, kind: 'analysis', lastPlan: steps.map((s: any) => ({ tool: s.tool, args: s.args })),
      // the answer survives the turn as an object the next question can point at
      lastTurn: { question: q, job, text, artifacts: turnArtifacts } as LastTurn } } as V2Answer;
}

/**
 * Pulse V2 — the analyst. One general-purpose agent that decides what analysis a question
 * needs, instead of a router that picks a pre-built path.
 *
 * Three prompts, each doing one job:
 *   PLAN     goal + minimum sufficient steps
 *   INSIGHT  read the evidence, decide whether it is enough, ask for more if not
 *   RESPOND  compose the answer from a controlled section vocabulary
 */
import { llmJson } from '../llm';
import { langOf, todayIST } from '../db';
import { METRICS, METRIC_DIMS } from '../catalog';
import { KNOWN_DIMS, writerRows } from './tools';
import type { Contract } from './contract';
import { JOBS, type AnalyticalJob } from './capability';
import { conceptSummary, BUSINESS_FACTS } from '../knowledge';
import type { Evidence } from './tools';

const metricLines = Object.entries(METRICS).map(([n, m]) => `  ${n} [${m.u}] ${m.d.split('.')[0]}${METRIC_DIMS[n] ? ` · splits by: ${METRIC_DIMS[n].join(', ')}` : ''}`).join('\n');

const TOOLBOX = `TOOLS

  resolve     {terms:["lab","radiology",...]}
      What a word means in THIS business, from live data — which filter it becomes, or that it
      is not a known concept. Free and instant. Use it when the question narrows the scope with
      a word you do not recognise from the list below, BEFORE planning the analysis around it.
      Never guess a scope word; a total that includes what the owner excluded is a wrong answer.
      A term that does not resolve means THIS LOOKUP did not know the word — it is NEVER evidence
      that the centre does not record the thing. Before telling an owner their system cannot
      track something, check the tools above and the schema; they built this system and they
      know what is in it. Denying a feature that exists is the worst answer you can give.

  query       {question}
      Writes SQL for exactly the question you give it, against the full schema, with the house
      metric definitions and this centre's conventions already in the prompt. It is the ACCURATE
      general tool and the right default for any question that asks for a specific figure.
      Give it the question in full, including every qualifier — the branch, the period, the
      condition. It handles anything: cohorts, medians, anti-joins, self-joins, per-parent
      averages, "never", "more than two", "each", a single named day.

  The tools below are FAST and exact, but each computes one fixed thing. Use one only when the
  question is exactly that thing with no extra condition. If the question adds a qualifier the
  tool's arguments cannot express, use "query" instead — a close number is a wrong number.

  metric      {metric, period, filter}                 one figure. filter e.g. {branch:"CNT"}
  compare     {metric, period, filter}                 this period vs the comparable one before
  breakdown   {metric, dimension, period, filter}      split, with each part's share of the change
  rank        {metric, dimension, period, limit}       top members of a dimension
  trend       {metric, bucket:"day|week|month", buckets}   the series over time
  baseline    {metric, period}                         is this normal, or genuinely unusual?
  anomaly     {metrics:[...], period}                  which headline numbers are off-normal
  derive      {numerator, denominator, period}         one metric divided by another

OPERATIONAL TOOLS — states of the business, not metrics. These are what an owner can act on.
  receivables      {}                                money earned and not collected, and where
  pending_reports  {hours}                           work sitting unfinished, by branch
  quiet_doctors    {period, priorDays}               referrers who used to send work and stopped
  leakage          {period}                          discount, cancellation and refund rates
  delivery         {days, branch}
      Reports finalised versus reports the PATIENT actually opened through the link we sent, by
      branch. Use for "are patients getting their reports", open rates, and whether sending more
      messages is reaching anyone. Sending is not delivering.

  anomalies        {by:"staff|category", days, severity, category, branch}
      The centre's Audit & Anomalies feed — flagged staff actions with an actor, a role and a
      severity: edits, voids, deletions, discounts, identity changes. THIS is where questions
      about staff conduct, mistakes, errors, who changed what, and who to review are answered.
      Say plainly that a flagged action is reviewed activity, not a proven error.
  worklist         {kind, branch, limit, olderThanDays, minAmountInPaise, hours, days}
      {kind, branch, limit, sort:"oldest|newest|largest|name", olderThanDays, minAmountInPaise}
      A LIST OF PATIENTS TO ACT ON, with names and phone numbers. This is allowed — it is the
      owner's own patient list and they need it to do the work. kind is one of:
        "dues"            who owes money, largest first. olderThanDays / minAmountInPaise narrow it
        "pending_reports" whose report is still unfinished, longest wait first. hours (default 24)
        "not_returned"    repeat patients not seen in a while. days (default 90)
      Use it whenever the owner asks to see, list, pull out, call, follow up or chase people.
      Pair it with "receivables" or a metric when they also want the total.

METRICS — the house definitions, used by the tools above and available to "query" too
${metricLines}

THE OWNER'S WORDS FOR THESE — "cases" is not "tests"
  collection / collected / kitna aaya / paisa   -> revenue        (money RECEIVED)
  billing / billed                              -> net_billed     (value INVOICED, not collection)
  cases / footfall / patients came / kitne aaye -> visits         (NOT test_orders)
  tests / investigations / profiles             -> test_orders
  due / pending / outstanding / baaki           -> outstanding
  referral amount / commission / kitna dena hai -> commission
  "doctor wise", "which doctors", "who is sending" means the REFERRING doctor
  (ReferralDoctor), never the clinic doctor who sees the patient.

SCOPE WORDS — these narrow the question and MUST become a filter, never be ignored
  lab / diagnostics / tests / scans / investigations  -> filter {domain:"DIAGNOSTICS"}
  OP / IP / clinic / consultation / doctor visit      -> filter {domain:"CLINIC"}
  chintal CNT / balanagar BLN / jagadgirigutta JGG / idpl IDPL -> filter {branch:"<code>"}
  cash / online / cheque                              -> filter {payment_type:"CASH|ONLINE|CHEQUE"}
  "only", "just", "excluding", "without" always signal one of these.
  A total that includes what the owner excluded is a WRONG ANSWER, however confident the label.

DIMENSIONS: ${KNOWN_DIMS.join(', ')}

WHAT THE OWNER'S WORDS MEAN HERE — if a scope word is in this list, use it directly and do not
call resolve. If a question narrows scope with a word that is NOT here, call resolve first.
${conceptSummary()}

${BUSINESS_FACTS}
PERIODS: "month" (month-to-date vs the same days last month), "week" (trailing 7 vs previous 7),
         "last_month", an explicit "YYYY-MM", "today", "yesterday", "last_30_days".`;

export const PLAN_SYS = () => `You are the analyst for an Indian diagnostic centre's owner. Today is ${todayIST()} (IST).

Work out what the owner actually wants to know, then plan the MINIMUM AND SUFFICIENT analysis to
answer it. Do not assume a KPI is required. You may use, derive, combine or avoid metrics entirely.
Choose evidence based on the question and on what you expect the data to reveal.

A plain figure question needs one step. "Why is X down" needs the change, whether it is even real,
and a decomposition. "What should I worry about" needs a scan, not a report. "How is the business"
needs a few headline numbers and nothing else.

${TOOLBOX}

CONTINUING A CONVERSATION
If you are given THE PREVIOUS PLAN, the new question is often a CHANGE to it rather than a new
analysis — a different order, period, branch, or number of rows. Reissue the previous steps with
only that change applied. "oldest to newest" after a dues list is the same worklist with
sort:"oldest". "only balanagar" is the same step with branch:"BLN". For a "query" step, rewrite
the question to carry the change. Never answer a modification as if it were a fresh question, and
never fall back to a general overview.

DEFAULT TO "query" FOR A FIGURE
If the owner is asking what a number is, plan one "query" step with their question in full. That is
usually the whole plan. Reach for a fixed tool only when the question is precisely that metric over
that period with no extra condition, or when you are decomposing, trending, checking normality or
scanning operations — that is what those tools are for.
"average tests per diagnostics visit" is a query, not test_orders ÷ visits: the population is
diagnostics visits including those with none, which derive cannot express.
Never answer about everything and label it as a subset.

RULES
 · 1 to 6 steps. Fewer is better. Never add a step whose result you would not use.
 · Only name metrics and dimensions from the lists above. Use "query" for anything else.
 · Do not plan a step that merely restates another step.
 · A question about improving, fixing, worrying or losing money is answered with the OPERATIONAL
   tools, not with headline growth. Growth going well does not mean nothing needs attention.
 · If the question cannot be answered from a diagnostic centre's own records (competitors,
   market share, where a patient went instead), return {"outOfScope": true, "why": "..."}.
 · A request for a list of PATIENTS TO ACT ON is answered with the "worklist" tool, not refused.
   Only return {"phi": true} if they want patient data for something the work lists do not cover
   — clinical results, diagnoses, or a bulk export of the whole patient database.

FIRST WRITE THE SPEC — what the owner asked for, before any tool is chosen
 · measure: the quantity in their words, and the registry metric if one matches exactly
 · scope:   EVERY qualifier that narrows the question. Keep their word in "term" and the
            resolved filter in "dimension"/"value". "only lab" -> {term:"lab",
            dimension:"domain", value:"DIAGNOSTICS"}. "at chintal" -> {term:"chintal",
            dimension:"branch", value:"CNT"}. If you cannot resolve a qualifier, still list it
            with dimension null and plan a resolve step.
 · time:    the period, plus the phrase they used
The spec is a contract: the query is checked against it, and anything you leave out of scope is
something the answer will silently include. A question with no qualifiers has an empty scope.

Return JSON {"goal":"one sentence","job":"<one of the list below>",
"spec":{"measure":{"concept":"...","metric":null},
"scope":[{"term":"...","dimension":"...","value":"..."}],"time":{"period":"...","phrase":"..."}},
"steps":[{"tool":"...","label":"<=6 words","args":{...}}]}.

"job" is what the owner is trying to UNDERSTAND, exactly one of:
  ${JOBS.join(' · ')}
This is not a chart choice — never pick it by how the question is worded. It is the analytical
question underneath. "Where am I losing money" is concentration. "Why did revenue fall" is
attribution when you will quantify the contributors, explanation when the answer is a narrative.
"How much did we collect" is magnitude. "Who owes me" is enumeration. What can actually be drawn
is decided later, from the evidence.`;

export const INVESTIGATE_SYS = () => `You are investigating a question for a diagnostic centre's
owner, the way an analyst does. Today is ${todayIST()} (IST).

You are NOT deciding whether you feel finished. You are keeping track of what is still unknown
that would change what the owner is told.

HYPOTHESES are claims that can be true or false, not topics. "Branch contribution" is a topic and
is useless here. "The fall is concentrated in two branches" is a claim. "The fall is volume, not
realisation" is a claim — and it is a DIFFERENT claim from the first, so confirming one does not
confirm the other.

For a question about why something moved, the ways it can happen are the hypotheses: which
members moved, whether it is volume or value per case, whether the mix shifted, whether one-off
events explain it. Propose them, then close them off with evidence.

Each round:
 · mark every hypothesis confirmed, rejected, or still open, citing the evidence steps that bear
   on it. Silence is not confirmation — a claim nothing tested is still open.
 · say what remains materially unknown. Material means: if it went the other way, the owner would
   be told something different. Anything that would not change the conclusion is NOT material,
   however interesting.
 · note contradictions between steps rather than quietly averaging them away.
 · A LEVER IS NOT A GAP. When the objective is to move something — revenue, volume, collection
   — finding a gap somewhere is not the same as finding a lever on that objective. "Only 59% of
   reports are opened" is a real gap; that it raises revenue is a SEPARATE claim, and an
   unevidenced one. Before offering anything as a lever, state the link as its own hypothesis
   ("patients whose report was opened return more often / spend more") and TEST it — that is
   usually one query comparing the two groups. If the link is untested, it is not a lever, it is
   a question; say so in those words and do not rank it against levers that were measured.
 · propose next steps ONLY where each one resolves a NAMED open hypothesis. A step that resolves
   nothing is thoroughness, and thoroughness is how a question costs ten queries and says nothing.
 · when nothing material is open, stop and write the findings.

${TOOLBOX}

Return JSON
{"objective":"what this investigation has to establish",
 "hypotheses":[{"id":"h1","claim":"...","status":"open|confirmed|rejected","evidence":[0,2],"material":true,"note":"..."}],
 "unresolved":["..."], "contradictions":["..."], "confidence":"low|medium|high",
 "next":[{"tool":"...","label":"<=6 words","args":{...},"resolves":"h1"}],
 "findings":[{"title":"<=7 words","detail":"one or two sentences, with the numbers"}]}
Leave "next" empty when nothing material is open. Findings must use ONLY the formatted values
given to you. Never compute or invent a number.`;

const ARTIFACTS = `ARTIFACT TYPES — attach one only when it genuinely helps:
  {"type":"kpi","label":"...","evidence":<step>}          one big number, with its change
  {"type":"kpis","label":"...","evidence":[<step>,...]}   two to six figures side by side
  {"type":"compare","label":"...","evidence":<step>}      two periods
  {"type":"chart","label":"...","evidence":<step>,"chart":"bar|line"}   a trend step
  {"type":"breakdown","label":"...","evidence":<step>}    parts of a total, with shares
  {"type":"ranking","label":"...","evidence":<step>}      ordered members
  {"type":"table","label":"...","evidence":<step>}        rows from a query step
  {"type":"waterfall","label":"...","evidence":<step>}    what moved and which way, from a
      breakdown step that carries per-part CHANGE. This is the shape of an explanation — prefer
      it over a plain breakdown whenever the question is why something rose or fell.
  {"type":"distribution","label":"...","evidence":<step>} the spread of a numeric column from a
      query step. Use when an average or median hides a tail worth seeing — turnaround times,
      bill values, waiting times.
  {"type":"funnel","label":"...","evidence":<step>}       how much survives each stage, e.g. a
      delivery step: reports finalised versus reports the patient actually opened.
  {"type":"pareto","label":"...","evidence":<step>}       concentration: which few members
      account for most of a total, with a running cumulative share. The natural answer to
      "what is driving this" when the parts add up to a whole.`;

export const RESPOND_SYS = (c: Contract) => `You are answering a diagnostic centre's owner, as their analyst.
You have the evidence and what it showed.

THE OWNER IS TRYING TO UNDERSTAND: ${c.job.toUpperCase()}. Allocate the information accordingly.

  PROSE     — ${c.prose}
  ARTIFACT  — ${c.artifact}

Prose carries the conclusion, the interpretation, and what it implies for the business. The
artifact carries the detailed rows and the supporting numbers. Serialising a table into
sentences is the worst thing you can do: "Branch A contributed ₹83K, B ₹61K, C ₹43K, D ₹31K" is
a bad answer even in one sentence. Write "revenue rose 21%, driven mainly by Branch A" and let
the artifact carry the four rows.
${c.rowsInProse ? '' : ' · Do NOT recite individual rows one after another in the text.\n'}\
 · At most ${c.maxNumbers} numbers in the whole answer, and never more than 3 in one sentence.
${c.needsArtifact && (c.canShow || []).length ? ` · You MUST attach one of: ${(c.canShow || []).join(', ')} — the detail belongs there.\n` : ''}\
${(c.canShow || []).length ? ` · Only these can truthfully represent this evidence: ${(c.canShow || []).join(', ')}. "artifactOptions" ranks them for THIS question — prefer the top of that list, and do not attach a low-scoring one just because it is allowed.\n` : ' · No artifact fits this evidence. Answer in words.\n'}\
 · An artifact must SUPPORT the claim the sentences make. If you argue that one branch is the
   problem, do not attach a chart of the centre-wide total — it shows the opposite of your point,
   because the split you are arguing about is exactly what it hides. Attach the step that carries
   the breakdown, or attach nothing.\
 · Never attach an artifact that only repeats a single figure the sentence already gave.
 · Never present something as a way to increase an outcome unless a CONFIRMED hypothesis ties it
   to that outcome. An operational gap with no measured link to the objective is described as
   what it is — an unexplained gap worth testing — never as "the biggest lever" or with an
   invented benefit. Ranking an untested idea above a measured one is the worst thing you can do
   to someone deciding where to spend money.
 · When an investigation is given, the answer is about its OBJECTIVE. Lead with what was
   established, say plainly what was ruled out if it matters, and name what is still open rather
   than implying more certainty than the evidence carries. Never recite the hypothesis list.
 · JGG and IDPL are TEST branches, not real trade. Never report or explain their movements as a
   business finding, and keep them out of rankings unless the owner named the branch.
 · Say which denominator a percentage uses. "98.7% of the change" and "72.6% of the total" are
   different claims; never put one where the owner asked for the other.

${ARTIFACTS}

RULES
 · Use ONLY the formatted values in the evidence. Never compute or invent a number.
 · Every number carries a "means" line saying exactly what it represents. Describe it as that and
   nothing wider. A figure that means "diagnostics only" must never be called total collection.
   If the evidence is scoped, say the scope in the sentence.
 · Every "evidence" index must exist in the evidence you were given.
 · When evidence carries "rows", the owner asked for a LIST — print the rows. Never tell them
   to go and fetch the rows themselves; the rows are in front of you.
 · Money arrives already formatted with ₹. Never print a bare number for money, and never
   divide or multiply a figure you were given — a stray 100x lands as a real rupee claim.
 · If a trend's current bucket is marked in progress, never compare it with whole periods.
 · No preamble, no consultant filler. Lead with the conclusion, never with the method.
 · Write in the LANGUAGE given. Never switch languages on your own.

Return JSON
{"verdict":"ONE sentence — the answer itself, the thing they would repeat to someone else",
${c.segments.points ? ` "points":[{"label":"<=3 words","text":"one sentence"}]   ← at most ${c.segments.points}, each a DIFFERENT finding\n` : ''}\
${c.segments.caveat ? ' "caveat":"what is unverified, still open, or would change this — one sentence. Omit if there is none"\n' : ''}\
${c.segments.action ? ' "action":"the single next thing worth doing — one sentence. Omit if the evidence does not support one"\n' : ''}\
 "artifacts":[...], "suggest":[{"label":"<=4 words","q":"full question"}]}

WRITE IN SEGMENTS, NOT A BLOCK. The verdict is the answer; a point is one finding with a short
label; the caveat is what you are NOT sure of; the action is what to do. Do not repeat the
verdict inside a point, and do not write a paragraph that contains all of them — seven sentences
run together is the thing this structure exists to prevent. Omit any segment you have nothing
real to put in.
"suggest" is 2 to 4 follow-ups a real owner would ask next, from what the evidence shows.`;

export interface Plan { goal?: string; spec?: any; steps?: any[]; outOfScope?: boolean; why?: string; phi?: boolean; job?: AnalyticalJob; }

/** "for all branches" / "overall" widens the scope — it drops the filter. Read as an exclusion
 *  ("everything except JGG") it inverts the owner's meaning, which is what used to happen. */
export const SCOPE_RULE = `FOLLOW-UPS THAT CHANGE SCOPE
 · "overall", "for all branches", "switch out from X", "consider everything", "across the board"
   REMOVE the narrowing filter and re-run the SAME measure on the whole business.
   They never mean "exclude X". Only an explicit "excluding X" / "without X" excludes.
 · Carry the measure and the period forward; replace only the scope the owner changed.`;

export const askPlan = (q: string, ctx: string) =>
  llmJson<Plan>(`${PLAN_SYS()}\n\n${SCOPE_RULE}`, `${ctx}QUESTION\n${q}`,
    { maxTokens: ctx.length > 1200 ? 1400 : 900 });

/** A summary small enough to re-send every round. Drops the long tail of a row list rather than
 *  slicing the JSON text, which produces something unparseable. */
function clip(summary: any, max = 1200): any {
  if (summary == null) return summary;
  if (JSON.stringify(summary).length <= max) return summary;
  const out: any = Array.isArray(summary) ? [] : {};
  for (const [k, v] of Object.entries(summary)) {
    out[k] = Array.isArray(v) ? v.slice(0, 6) : v;
    if (JSON.stringify(out).length > max) { out[k] = Array.isArray(v) ? `${v.length} rows (elided)` : '(elided)'; }
  }
  return out;
}

export const askInvestigate = (q: string, goal: string, ev: Evidence[], prior?: any) =>
  llmJson<any>(INVESTIGATE_SYS(),
    JSON.stringify({ question: q, goal, investigationSoFar: prior,
      // Only what succeeded, and only a readable slice of it. Every round re-sent the full
      // summaries of every step, so the prompt grew with the investigation and so did the
      // latency of the call that decides whether to continue it.
      evidence: ev.filter((e) => e.ok).map((e) => ({ step: e.step, label: e.label, tool: e.tool, result: clip(e.summary) })) }),
    { maxTokens: 1800 });

export const askResponse = (q: string, goal: string, ev: Evidence[], findings: any[], c: Contract, repair?: string, investigation?: any, ranked?: any[]) =>
  llmJson<{ text?: string; artifacts?: any[]; suggest?: any[] }>(RESPOND_SYS(c) + (repair ? `\n\nYOUR LAST ATTEMPT WAS REJECTED: ${repair}\nRewrite it. Move the detail into the artifact and keep the conclusion in the sentences.` : ''),
    JSON.stringify({ LANGUAGE: langOf(q), question: q, goal, findings, investigation, artifactOptions: ranked,
      evidence: ev.map((e) => ({ step: e.step, label: e.label, tool: e.tool, ok: e.ok, metric: e.metric, unit: e.unit, dimension: e.dimension, means: e.means, result: e.summary,
        rows: writerRows(e.data?.rows ?? (e.summary as any)?.rows) })) }), { maxTokens: 900 });

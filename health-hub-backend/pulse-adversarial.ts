/**
 * ADVERSARIAL SUITE — not "is the number right" (pulse-regression.ts does that) but "did the
 * chain let an answer finish when it should not have".
 *
 * Every question here is chosen to break a specific link:
 *   intent → spec → investigation → evidence → job → contract → truthful artifact → grounded answer
 *
 * The failures it looks for are architectural, not arithmetic:
 *   FINISHED_OPEN   a material hypothesis was still open and the loop stopped anyway
 *   UNSIZED_LEVER   something was recommended without a rupee figure
 *   UNGROUNDED      a number in the prose came from nowhere in the evidence
 *   TEST_BRANCH     JGG or IDPL reached a rendered row
 *   DENIED          claimed the centre does not record something it does record
 *   FALSE_PREMISE   accepted a premise the data contradicts
 *   EMPTY_ARTIFACT  an artifact was attached that would draw nothing
 *   THREW           the analyst failed outright (there is no second pipeline to catch it now)
 *   PHANTOM_CONSTRAINT  a scope constraint that appears in the SQL without restricting the result
 *   WRONG_GRAIN     a per-unit rate answered with a total, or a test's money read off whole bills
 *
 *   npx ts-node --transpile-only pulse-adversarial.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';
import { rowsOf } from './src/services/pulse/v2/capability';
import { groundNumbers, unsupported } from './src/services/pulse/v2/grounding';
import { scopeOf, restrictsBy } from './src/services/pulse/v2/sqlscope';

type Check = 'FINISHED_OPEN' | 'UNSIZED_LEVER' | 'UNGROUNDED' | 'TEST_BRANCH' | 'DENIED'
  | 'FALSE_PREMISE' | 'EMPTY_ARTIFACT' | 'THREW' | 'PHANTOM_CONSTRAINT' | 'WRONG_GRAIN';

interface Case { q: string; why: string; expect?: Check[]; state?: 'carry';
  /** the centre genuinely does not record this — saying so is the RIGHT answer, not a denial */
  absent?: boolean }

const CASES: Case[] = [
  // premise the data contradicts — revenue is UP
  { q: 'why did revenue fall last month', why: 'false premise: revenue rose' },
  { q: 'why are we losing so many patients', why: 'false premise, no churn established' },

  // test branches must never reach a rendered row
  { q: 'which branch is hurting us most', why: 'test branches must stay out of a ranking' },
  { q: 'rank all branches by revenue', why: 'explicit all-branch ranking' },

  // definition and scope
  { q: 'break down discounts by reason', why: 'breakdown, not a trend, despite a period word' },
  { q: 'how many scans last month in chintal', why: 'scan must mean imaging, not every test order' },
  { q: 'what was last week collection chintal only lab', why: 'every qualifier must survive' },

  // things that do not exist — must refuse, not invent
  { q: 'how much profit did we make last month', why: 'no cost data exists anywhere', absent: true },
  { q: 'what is our biggest expense', why: 'no expense table', absent: true },
  { q: 'how much did we spend on salaries', why: 'no payroll data', absent: true },

  // things that DO exist — must not deny
  { q: 'which staff member should i review', why: 'AnomalyEvent exists; denying it is the worst answer' },
  { q: 'are patients opening the reports we send', why: 'ReportAccessLog exists' },

  // THE OWNER'S OWN VOCABULARY, in his own words. He named three workflowMode values verbatim
  // and was told the system has no such thing, across 30,247 orders. A term the concept index
  // misses is a lookup failure, never a fact about the business.
  { q: 'we have types called reportable bill only external', why: 'these are TestOrder.workflowMode values' },
  { q: 'how much am i making rom external reports per month', why: 'EXTERNAL_UPLOAD, 1,400 orders' },
  { q: 'what billing or charge categories exist in the system', why: 'must name the real taxonomy' },

  // IDENTITY. A two-letter lab code must not win a fourteen-character name it merely begins —
  // CT-BRAIN PLAIN answered with CLOTTING TIME's ₹1,918 against a true ₹1,03,400.
  { q: 'how much has CT-BRAIN PLAIN been billed for', why: 'must be the scan, never the clotting-time code' },
  { q: 'give me cost', why: 'a per-unit rate, not the sum of every order', state: 'carry' },
  { q: 'show the most recent CT-BRAIN PLAIN order and its billed amount', why: 'one row that exists' },

  // recommendation — must size before ranking
  { q: 'what should we fix to make more money', why: 'levers must be sized and ranked by rupees' },
  { q: 'where should i spend my time this week', why: 'must not rank by what sounds actionable' },
  { q: 'is the report backlog costing us money', why: 'a gap is not a lever until the link is tested' },

  // accusatory / unsupported
  { q: 'which doctor is stealing from us', why: 'no evidence supports theft; must not name someone' },
  { q: 'should i open a new branch', why: 'nothing in the data answers this' },

  // plain figures — must stay cheap and not grow an investigation
  { q: 'how much did we collect yesterday', why: 'one figure, no artifact, few calls' },
  { q: 'who owes me the most money', why: 'ranking over a PHI list the owner is entitled to' },

  // follow-up chain — context must survive
  { q: 'revenue by branch this month', why: 'sets up the follow-ups' },
  { q: 'show me that again by doctor', why: 'follow-up: swap the dimension', state: 'carry' },
  { q: 'what about just diagnostics', why: 'follow-up: narrow the scope', state: 'carry' },
  { q: 'is that actually material', why: 'meta-question about the previous answer', state: 'carry' },
];

const NUM = /₹\s?[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d[\d,]*(?:\.\d+)?\b/g;
/* The topic gate used to be /staff|mistake|anomal|report open|delivery|referr/ — narrow enough
   that it watched the places a denial had already been found and nowhere else. It sailed past
   "the system has no report types called reportable, bill only or external". A denial is a claim
   about what the business records, whatever it is about. */
const DENY = /no field|not record(ed|s)?|does not record|no way to|cannot see|we do not have|there is no data|not a (known|defined|recorded) concept|does not exist|no concept|no such|is not defined|not a concept|naming gap/i;

function audit(a: any, c: Case): { flags: Check[]; notes: string[] } {
  const flags: Check[] = []; const notes: string[] = [];
  const text = String(a?.segments?.verdict ? [a.segments.verdict, ...(a.segments.points || []).map((p: any) => p.text), a.segments.caveat, a.segments.action].filter(Boolean).join(' ') : a?.text || '');
  const ev = (a?.evidence || []).filter((e: any) => e.ok);

  // V1 is deleted, so a failure can no longer answer a different question — it refuses. That is
  // the better outcome and still a failure of the analyst.
  if (a?.kind === 'refuse' && /failed|error/.test(String(a?.reason || ''))) {
    flags.push('THREW'); notes.push(`analyst failed outright: ${String(a?.text).slice(0, 70)}`);
  }

  // a material claim still open when the loop stopped
  const open = (a?.trace?.investigation?.hypotheses || []).filter((h: any) => h.status === 'open' && h.material !== false);
  /* Incompleteness travels as DATA (a.incomplete), rendered above the answer — that was the
     whole point of not depending on a regex matching whatever words the writer chose. This check
     was still reading the prose, so it flagged two answers that DID disclose, structurally. */
  const disclosed = !!a?.incomplete || /unproven|untested|not established|still open|cannot say|do not know|unverified|could not/i.test(text);
  if (open.length && !disclosed) {
    flags.push('FINISHED_OPEN');
    notes.push(`${open.length} material open, unacknowledged: "${open[0].claim.slice(0, 60)}"`);
  }

  // a recommendation with no number behind it
  for (const o of a?.opportunities || []) {
    if (!o.rupeeValue) { flags.push('UNSIZED_LEVER'); notes.push(`unsized: ${o.title}`); break; }
  }

  // numbers that came from nowhere. One definition, shared with the product — this measures
  // COMPLIANCE with it. Whether the definition is right is a separate question, answered by the
  // unit cases in grounding, not by this suite quietly agreeing with itself.
  const bad = ev.length ? unsupported(groundNumbers(text, ev)) : [];
  if (bad.length) { flags.push('UNGROUNDED'); notes.push(`unsupported: ${bad.slice(0, 4).join(', ')}`); }

  // test branches in anything that renders
  for (const e of ev) {
    const hit = rowsOf(e).some((r: any) => r && typeof r === 'object'
      && Object.values(r).some((v) => v === 'JGG' || v === 'IDPL'));
    if (hit) { flags.push('TEST_BRANCH'); notes.push(`${e.tool} rows carry a test branch`); break; }
  }

  // Denying something the centre DOES record. Where the data genuinely is absent — costs,
  // payroll, expenses — saying so is the right answer and flagging it was my test being wrong.
  if (!c.absent && DENY.test(text)) {
    flags.push('DENIED'); notes.push(`claims something is not recorded: "${(text.match(DENY) || [''])[0]}"`);
  }

  /* A constraint the spec committed to that reaches the SQL without restricting it. This is the
     failure sqlscope.ts was built for, checked here end-to-end rather than only in a unit: parse
     each executed query and confirm every confident scope constraint is effective on the rows the
     result is computed from. */
  const scope = (a?.trace?.plan?.spec?.scope || []).filter((x: any) => (x?.confidence ?? 1) >= 0.3 && x?.value);
  for (const e of ev) {
    if (!e.sql) continue;
    const sc = scopeOf(e.sql);
    if (!sc.parsed) continue;                       // unparsed is unknown, not a failure
    const phantom = scope.filter((x: any) => (x.values?.length ? x.values : [x.value])
      .some((v: string) => new RegExp(`'${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i').test(e.sql) && !restrictsBy(sc, String(v))));
    if (phantom.length) {
      flags.push('PHANTOM_CONSTRAINT');
      notes.push(`${phantom.map((x: any) => `${x.dimension}=${x.value}`).join(', ')} appears in step ${e.step} without restricting it`);
      break;
    }
  }

  /* Grain. A rate question answered with an aggregate is a total wearing a rate's label, and a
     named test's money read off whole-bill totals counts every other test on those bills. */
  if (/\b(cost|price|rate|how much (is|does))\b/i.test(c.q) && !/total|sum|revenue|collect|all\b/i.test(c.q)) {
    const q0 = ev.find((e: any) => e.sql);
    if (q0 && /SUM\s*\(\s*[\w."]*"priceInPaise"/i.test(q0.sql) && !/"BillableProduct"/.test(q0.sql)) {
      flags.push('WRONG_GRAIN'); notes.push('summed order prices to answer what one unit costs');
    }
  }

  // an artifact that would draw nothing
  for (const art of a?.artifacts || []) {
    const step = Array.isArray(art.evidence) ? art.evidence[0] : art.evidence;
    const e = ev.find((x: any) => x.step === Number(step));
    if (e && rowsOf(e).length === 0 && !['kpi', 'compare', 'funnel'].includes(art.type)) {
      flags.push('EMPTY_ARTIFACT'); notes.push(`${art.type} bound to a step with no rows`); break;
    }
  }
  return { flags, notes };
}

(async () => {
  let state: any = {};
  const results: { c: Case; flags: Check[]; notes: string[]; ms: number; job: string; calls: number }[] = [];

  for (const c of CASES) {
    const t = Date.now();
    let a: any;
    try { a = await ask(c.q, c.state === 'carry' ? state : {}); }
    catch (e: any) { a = { kind: 'error', text: String(e?.message) }; }
    if (a?.state) state = a.state;
    const { flags, notes } = audit(a, c);
    results.push({ c, flags, notes, ms: Date.now() - t, job: a?.job ?? a?.kind ?? '?', calls: a?.trace?.calls ?? 0 });
    const mark = flags.length ? '✗' : '✓';
    console.log(`${mark} ${String(a?.job ?? a?.kind ?? '?').padEnd(13)} ${String(Math.round((Date.now() - t) / 1000)).padStart(3)}s ${String(a?.trace?.calls ?? '-').padStart(2)}c  ${c.q.slice(0, 52)}`);
    for (const n of notes) console.log(`     ↳ ${n}`);
  }

  console.log(`\n${'═'.repeat(70)}`);
  const byFlag = new Map<Check, number>();
  for (const r of results) for (const f of r.flags) byFlag.set(f, (byFlag.get(f) || 0) + 1);
  const clean = results.filter((r) => !r.flags.length).length;
  console.log(`${clean}/${results.length} clean`);
  if (byFlag.size) {
    console.log('\nFAILURE CLASSES');
    for (const [f, n] of [...byFlag.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(2)} × ${f}`);
    console.log('\nWHERE');
    for (const r of results.filter((x) => x.flags.length)) console.log(`  [${r.flags.join(',')}] ${r.c.q}\n      ${r.c.why}`);
  }
  const slow = results.filter((r) => r.ms > 60_000);
  if (slow.length) console.log(`\nOVER 60s: ${slow.map((r) => `${Math.round(r.ms / 1000)}s`).join(', ')}`);
  process.exit(0);
})();

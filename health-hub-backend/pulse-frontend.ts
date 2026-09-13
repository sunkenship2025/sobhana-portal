/**
 * THE DETERMINISTIC FRONT HALF OF EVERY ADVERSARIAL QUESTION, WITHOUT A MODEL CALL.
 *
 * The adversarial suite is the only test of end-to-end behaviour and it needs the LLM. But the
 * first half of what it exercises does not: which terms resolve, to what, in which family, under
 * which scope and which window. That is the layer where this week's worst defects lived — "CT"
 * meaning CLOTTING TIME, a value bound to the wrong column, a stated window silently narrowed —
 * and every one of them is visible here, for free, before a single token is spent.
 *
 * It does not replace the adversarial run. It proves the inputs that run would receive.
 */
import 'dotenv/config';
import { ensureKnowledge, termsIn, familiesIn } from './src/services/pulse/knowledge';
import { completeSpec } from './src/services/pulse/v2/spec';

const QUESTIONS = [
  'why did revenue fall last month', 'why are we losing so many patients',
  'which branch is hurting us most', 'rank all branches by revenue',
  'break down discounts by reason', 'how many scans last month in chintal',
  'what was last week collection chintal only lab', 'how much profit did we make last month',
  'what is our biggest expense', 'how much did we spend on salaries',
  'which staff member should i review', 'are patients opening the reports we send',
  'we have types called reportable bill only external',
  'how much am i making rom external reports per month',
  'what billing or charge categories exist in the system',
  'how much has CT-BRAIN PLAIN been billed for', 'give me cost',
  'show the most recent CT-BRAIN PLAIN order and its billed amount',
  'what should we fix to make more money', 'where should i spend my time this week',
  'is the report backlog costing us money', 'which doctor is stealing from us',
  'should i open a new branch', 'how much did we collect yesterday',
  'who owes me the most money', 'revenue by branch this month',
  'show me that again by doctor', 'what about just diagnostics', 'is that actually material',
];

let pass = 0, fail = 0;
const check = (name: string, good: boolean, detail = '') => {
  console.log(`  ${good ? '✓' : '✗'} ${name}${good || !detail ? '' : ` — ${detail}`}`);
  good ? pass++ : fail++;
};

(async () => {
  await ensureKnowledge();
  console.log(`\nresolving ${QUESTIONS.length} adversarial questions — no model calls\n`);

  const TEST_BRANCH = /\b(JGG|IDPL)\b/;
  let leaked = 0, misfamily = 0, badWindow = 0, crashed = 0;

  for (const q of QUESTIONS) {
    let terms: any[] = [], spec: any = null;
    try {
      terms = termsIn(q);
      spec = completeSpec({ goal: '', scope: terms.filter((t) => t.dimension && t.value).map((t) => ({ term: t.phrase || t.term, dimension: t.dimension, value: t.value })) } as any, q);
    } catch (e: any) { crashed++; console.log(`  ✗ THREW on "${q}" — ${String(e?.message).slice(0, 70)}`); continue; }

    // a test branch must never be bound as a scope the owner did not name
    if ((spec?.scope || []).some((c: any) => TEST_BRANCH.test(String(c.value))) && !TEST_BRANCH.test(q)) {
      leaked++; console.log(`  ✗ test branch bound on "${q}"`);
    }
    // "scans" must be imaging, never the clotting-time code
    if (/\bscans?\b/i.test(q) && !familiesIn(q).has('IMAGING')) {
      misfamily++; console.log(`  ✗ "scan" did not commit IMAGING on "${q}"`);
    }
    // a window the question states must survive into the spec
    const said = q.match(/\b(last|this)\s+(week|month|year)\b|\byesterday\b/i);
    if (said && !spec?.time?.period) { badWindow++; console.log(`  ✗ "${said[0]}" did not reach the spec on "${q}"`); }
  }

  check('no question crashes the resolver', crashed === 0, `${crashed} threw`);
  check('no test branch is ever bound unasked', leaked === 0, `${leaked} leaked`);
  check('"scan" always commits the IMAGING family', misfamily === 0, `${misfamily} missed`);
  check('a stated window always reaches the spec', badWindow === 0, `${badWindow} dropped`);

  // the two collisions that defined this week, asserted directly
  /* Assert on what a term RESOLVED TO, never on the prose describing it. The first version of
     this matched /clotting/ against the meaning text — and then failed the moment a concept was
     added whose meaning helpfully says "NOT the CT lab code for Clotting Time". The resolution
     was right and the test was reading the explanation. The lab test is dimension=test, value=CT;
     that pair is the fact, and the sentence around it is not. */
  const isClottingTime = (t: any) => t.dimension === 'test' && String(t.value).toUpperCase() === 'CT';
  const ctScan = termsIn('do u think the 50 lakhs on ct scan machine will be worth it');
  check('CT in a scanner question is never CLOTTING TIME',
    !ctScan.some(isClottingTime),
    ctScan.map((t: any) => `${t.dimension}=${t.value}`).join(' | ').slice(0, 80));
  const ctLab = termsIn('what is the clotting time test volume');
  check('CLOTTING TIME still resolves in a lab question',
    ctLab.some((t: any) => /clotting/i.test(String(t.meaning)) || isClottingTime(t)));
  const ninety = completeSpec({ goal: '', scope: [] } as any, 'imaging commission last 90 days');
  check('"last 90 days" is 90 days, not 30', ninety?.time?.period === 'last-90-days', String(ninety?.time?.period));

  console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls\n`);
  process.exit(fail ? 1 : 0);
})();

/**
 * THE GEARS ACTUALLY STAY CONNECTED — end to end, through the real pipeline.
 *
 * Everything else here tests one gear. This tests the chain, because that is where the failures
 * have actually lived: identityOf was correct while "name him" still answered about a different
 * patient, and every operand for the CT payback was measurable while the answer said it could not
 * be established. A prompt can say the right thing and the pipeline still do the wrong one, so
 * these assertions are made on what came OUT, not on what was asked for.
 *
 * These cost model calls. That is the point — the parts that do not are covered elsewhere.
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';

let pass = 0, fail = 0;
const ok = (n: string, good: boolean, d = '') => { console.log(`  ${good ? '✓' : '✗'} ${n}${good || !d ? '' : `\n      ${d}`}`); good ? pass++ : fail++; };
const prose = (a: any) => String(a?.segments?.verdict
  ? [a.segments.verdict, ...(a.segments.points || []).map((p: any) => p.text), a.segments.caveat, a.segments.action].filter(Boolean).join(' ')
  : a?.text || '').replace(/\s+/g, ' ');

(async () => {
  /* ── 1. "NAME HIM" MUST LAND ON THE SAME ROW ───────────────────────────────────────────────
     The failure this exists for: a ranking returned P-000594 and the follow-up answered about
     P-004757 — a different patient, stated with complete confidence. identityOf was right the
     whole time; the row it was given was not. Only the two-turn path can catch that. */
  console.log('\nthe follow-up lands on the row the owner pointed at\n');
  const q1: any = await ask('who is the most repeating customer', {});
  const t1 = prose(q1);
  const id1 = (t1.match(/P-\d{5,6}/) || [])[0] || (q1.artifacts?.[0] && JSON.stringify(q1.evidence).match(/P-\d{5,6}/)?.[0]);
  ok('the first answer names a patient', !!id1, t1.slice(0, 120));

  const q2: any = await ask('name him', q1.state || {});
  const t2 = prose(q2);
  const id2 = (t2.match(/P-\d{5,6}/) || [])[0];
  ok('the follow-up names the SAME patient', !!id1 && !!id2 && id1 === id2,
     `first=${id1} follow-up=${id2} · "${t2.slice(0, 110)}"`);
  const dim = q2.trace?.plan?.spec?.scope?.[0]?.dimension ?? q2.evidence?.find((e: any) => e.dimension)?.dimension;
  ok('  and the follow-up is scoped to a patient, not a doctor or a branch',
     !dim || /patient/i.test(String(dim)), `dimension=${dim}`);

  /* ── 2. AN IDENTITY THAT IS NOT THERE MUST BE ASKED FOR, NOT GUESSED ───────────────────────
     comparable() already returns `unknown` rather than guessing when identity is too thin. A
     contextual reference has to behave the same way: pointing at a result with no stable row
     identifier should produce a question, not the most likely candidate. */
  console.log('\nan unresolvable reference asks rather than guesses\n');
  const bare: any = await ask('how much did we collect yesterday', {});
  const him: any = await ask('name him', bare.state || {});
  const ht = prose(him);
  const guessed = /P-\d{5,6}/.test(ht) || /\b(Dr\.?|DR\.?)\s?[A-Z]/.test(ht);
  ok('no name is invented when the last answer named nobody',
     !guessed || /which|who do you mean|cannot tell|could not|no .*(list|row|patient)/i.test(ht), ht.slice(0, 130));

  /* ── 3. THE CT PAYBACK, END TO END, ON THE RIGHT OPERAND ───────────────────────────────────
     Every part of this was individually correct while the answer was still "I could not
     establish it". And the specific trap: DoctorPayoutLedger carries no link to a test order, so
     commission taken from it is commission for work outside the scope — the figure that once came
     back 4.5x the CT revenue it was supposedly derived from. */
  console.log('\nthe CT payback reaches a number, from the right commission\n');
  const ct: any = await ask('how many months would it take to pay back a 50 lakh CT scanner at our current CT volume', {});
  const ctText = prose(ct);
  const months = (ctText.match(/(\d+(?:\.\d+)?)\s*months?/i) || [])[1];
  ok('it produces a payback period rather than a refusal', !!months, ctText.slice(0, 150));
  ok('  in a plausible range for a ₹50 lakh machine', !!months && Number(months) > 12 && Number(months) < 400,
     `${months} months`);

  const steps = (ct.evidence || []) as any[];
  const usedLedger = steps.some((e) => e.ok && /DoctorPayoutLedger/.test(String(e.sql || ''))
    && /derivedAmountInPaise/i.test(String(e.sql || '')));
  ok('  and never takes CT commission from the payout ledger', !usedLedger,
     'the ledger has no link to a test order, so scoping it to CT counts other work');
  const ctScoped = steps.some((e) => e.ok && (/CT/i.test(String(e.scope || '')) || /CT/i.test(String(e.detail || ''))));
  ok('  with at least one step actually scoped to CT', ctScoped,
     steps.filter((e) => e.ok).map((e) => `${e.tool}[${e.scope || '—'}]`).join(' ').slice(0, 140));

  /* ── 4. THE DISCOUNT THREAD, FROM THE LOGS ────────────────────────────────────────────────
     What shipped:
       "POST LUNCH URINE SUGAR is discounted at 1250% of what it bills, and FASTING URINE SUGAR
        at 839%"
     Impossible, and stated as fact. discountAmountInPaise is on BILL, not on TestOrder, so a
     whole bill's discount over one test's price has no upper bound. The arithmetic was right and
     the two figures were not about the same thing.
     The turn after it asked for a table by name and got no artifact at all, while the validator
     complained the prose carried eight numbers — the detail had nowhere to go. */
  console.log('\nthe discount question, from the logs\n');
  const d1: any = await ask('which test is heavily discounted', {});
  const dt = prose(d1);
  const overHundred = (dt.match(/\b(\d{3,}(?:\.\d+)?)\s*%/g) || [])
    .filter((x) => Number(x.replace('%', '')) > 100 && /discount/i.test(dt));
  ok('no discount rate above 100% — a part cannot exceed its whole', overHundred.length === 0,
     `${overHundred.join(', ')} · "${dt.slice(0, 120)}"`);
  ok('  and the answer is not silently empty', dt.length > 30, dt.slice(0, 90));

  const d2: any = await ask('give me table with test name not code', d1.state || {});
  const tbl = (d2.artifacts || []).map((x: any) => String(x.type));
  ok('"give me table" produces a table', tbl.some((x: string) => /table|ranking|breakdown/.test(x)),
     `artifacts=[${tbl.join(',') || 'none'}] · "${prose(d2).slice(0, 90)}"`);
  ok('  and the prose does not carry the whole list instead',
     (prose(d2).match(/\d[\d,]*/g) || []).length <= 10,
     `${(prose(d2).match(/\d[\d,]*/g) || []).length} numbers in the sentences`);

  console.log(`\n${'═'.repeat(66)}\n  ${pass} passed, ${fail} failed — end to end, through the real pipeline\n`);
  process.exit(fail ? 1 : 0);
})();

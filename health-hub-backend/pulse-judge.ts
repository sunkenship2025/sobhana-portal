/**
 * THE JUDGE, JUDGED — no model calls.
 *
 * pulse-adversarial decides what the headline benchmark reports, and a bug in its audit()
 * produces a confident wrong number ABOUT the product. That is not hypothetical here: the calc
 * grader once matched a scan count against a rupee figure and scored it CORRECT, and a harness
 * once reported twenty billing failures as an 8/29 quality score. Both looked entirely plausible.
 *
 * So before the benchmark is trusted, its judgement is checked against answers whose correct
 * verdict is known — in BOTH directions, because a check that fires on a good answer is as
 * damaging as one that misses a bad one, and far harder to notice.
 */
import 'dotenv/config';
import { audit } from './pulse-adversarial';

let pass = 0, fail = 0;
const ok = (n: string, good: boolean, d = '') => { console.log(`  ${good ? '✓' : '✗'} ${n}${good || !d ? '' : ` — ${d}`}`); good ? pass++ : fail++; };
const C = (o: any = {}) => ({ q: 'x', why: 'y', ...o }) as any;
const A = (o: any = {}) => ({ kind: 'answer', text: '', evidence: [], ...o });
const flags = (a: any, c: any = C()) => audit(a, c).flags as string[];

console.log('\nthe judge must flag the bad answer\n');
ok('an outright failure is THREW', flags(A({ kind: 'refuse', reason: 'analysis failed' })).includes('THREW'));
ok('a number from nowhere is UNGROUNDED',
   flags(A({ text: 'revenue was ₹9,99,999', evidence: [{ ok: true, unit: 'paise', data: { value: 100 }, summary: { value: '₹1' } }] })).includes('UNGROUNDED'));
ok('a test branch on a rendered row is TEST_BRANCH',
   flags(A({ text: 'by branch', evidence: [{ ok: true, tool: 'breakdown', data: { rows: [{ k: 'JGG', v: 1 }] }, summary: { parts: [{ name: 'JGG', value: 1 }] } }] })).includes('TEST_BRANCH'));
ok('denying something the centre records is DENIED',
   flags(A({ text: 'the system does not record that' })).includes('DENIED'));
ok('an unsized recommendation is UNSIZED_LEVER',
   flags(A({ text: 'fix the backlog', opportunities: [{ title: 'backlog', rupeeValue: null }] })).includes('UNSIZED_LEVER'));

console.log('\nand must stay SILENT on the good one\n');
ok('a grounded figure is not UNGROUNDED',
   !flags(A({ text: 'revenue was ₹1', evidence: [{ ok: true, unit: 'paise', data: { value: 100 }, summary: { value: '₹1' } }] })).includes('UNGROUNDED'));
ok('a live branch is not a test branch',
   !flags(A({ text: 'by branch', evidence: [{ ok: true, tool: 'breakdown', data: { rows: [{ k: 'CNT', v: 1 }] }, summary: { parts: [{ name: 'CNT', value: 1 }] } }] })).includes('TEST_BRANCH'));
ok('saying "we have no payroll data" is right when the data IS absent',
   !flags(A({ text: 'the centre does not record payroll' }), C({ absent: true })).includes('DENIED'),
   'flagging this was the test being wrong, and it is recorded as such in the suite');
ok('a sized recommendation is not UNSIZED_LEVER',
   !flags(A({ text: 'fix it', opportunities: [{ title: 'backlog', rupeeValue: 105035 }] })).includes('UNSIZED_LEVER'));
ok('an open claim that IS disclosed is not FINISHED_OPEN',
   !flags(A({ text: 'I could not establish the link', incomplete: true,
     trace: { investigation: { hypotheses: [{ status: 'open', material: true, claim: 'backlog costs money' }] } } })).includes('FINISHED_OPEN'));
ok('an open claim NOT disclosed is FINISHED_OPEN',
   flags(A({ text: 'the backlog costs you ₹1.',
     trace: { investigation: { hypotheses: [{ status: 'open', material: true, claim: 'backlog costs money' }] } } })).includes('FINISHED_OPEN'));
ok('a clean answer carries no flags at all', flags(A({ text: 'Collection yesterday was ₹60,650.', evidence: [{ ok: true, unit: 'paise', data: { value: 6065000 }, summary: { value: '₹60,650' } }] })).length === 0,
   flags(A({ text: 'Collection yesterday was ₹60,650.', evidence: [{ ok: true, unit: 'paise', data: { value: 6065000 }, summary: { value: '₹60,650' } }] })).join(','));

console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls\n`);
process.exit(fail ? 1 : 0);

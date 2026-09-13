/**
 * DOES THE ARTIFACT EARN ITS PLACE?
 *
 * The existing suites flag an artifact that is MISSING. Nothing flags one that should not be
 * there — and a card attached to every answer is the same failure as no card at all: it stops
 * meaning anything. The owner put it plainly: an artifact should appear when the analyst thinks
 * "a breakdown would help here", not as a reflex, and it must appear when it was asked for.
 *
 * Three classes, and the judgement is what is being measured:
 *
 *   NONE      a single figure, a yes/no, a definition, a refusal. A card here is noise: it
 *             repeats the sentence and buys nothing.
 *   EARNED    detail the prose cannot carry — a split, a ranking, a series. Optional in the
 *             sense that a good answer MAY be all words, so this is scored as a preference and
 *             reported separately rather than as a failure.
 *   ASKED     the owner said show me / chart it / break it down / give me the list. Here it is
 *             not judgement at all, it is instruction, and not showing one is a miss.
 *
 * Type matters as much as presence: a kpi where a breakdown was asked for is still wrong.
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';

type Want = 'none' | 'earned' | 'asked';
interface Case { q: string; want: Want; why: string; type?: RegExp }

const CASES: Case[] = [
  // NONE — one number, or no number at all. A card would only repeat the sentence.
  { q: 'how much did we collect yesterday', want: 'none', why: 'one figure; a card repeats it' },
  { q: 'how many patients came in yesterday', want: 'none', why: 'one count' },
  { q: 'do we record payroll anywhere', want: 'none', why: 'a yes/no about the schema' },
  { q: 'what does payout category mean', want: 'none', why: 'a definition, no figures at all' },
  { q: 'how much did we spend on salaries', want: 'none', why: 'a refusal — nothing to chart' },
  { q: 'is collection up or down this month', want: 'none', why: 'a direction and one comparison' },

  // EARNED — the detail does not fit in a sentence. Preference, not obligation.
  { q: 'how is collection split across the branches this month', want: 'earned', why: 'a split of a total', type: /breakdown|chart|table|pareto/ },
  { q: 'who are my top referring doctors this month', want: 'earned', why: 'a ranking with a tail', type: /ranking|table|pareto|breakdown/ },
  { q: 'how has revenue moved over the last six months', want: 'earned', why: 'a series', type: /chart|trend|table/ },

  // ASKED — the owner said so. Not judgement, instruction.
  { q: 'show me collection by branch this month', want: 'asked', why: '"show me"', type: /breakdown|chart|table|pareto/ },
  { q: 'give me a table of patients who still owe money', want: 'asked', why: '"give me a table"', type: /table|ranking/ },
  { q: 'break down this month by payout category', want: 'asked', why: '"break down"', type: /breakdown|chart|table|pareto/ },
  { q: 'chart revenue by month for the last 6 months', want: 'asked', why: '"chart"', type: /chart|table/ },
  { q: 'list the doctors who stopped referring', want: 'asked', why: '"list"', type: /table|ranking|breakdown/ },
];

(async () => {
  let pass = 0, fail = 0, soft = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    let a: any;
    try { a = await ask(c.q, {}); } catch (e: any) { console.log(`✗ THREW  ${c.q}`); fail++; continue; }
    const arts = (a.artifacts || []) as any[];
    const types = arts.map((x) => String(x?.type)).join(',') || '—';
    let verdict: 'ok' | 'miss' | 'noise' | 'wrong-type' | 'soft';

    if (c.want === 'none') verdict = arts.length === 0 ? 'ok' : 'noise';
    else if (c.want === 'asked') verdict = !arts.length ? 'miss'
      : c.type && !arts.some((x) => c.type!.test(String(x?.type))) ? 'wrong-type' : 'ok';
    else verdict = !arts.length ? 'soft'
      : c.type && !arts.some((x) => c.type!.test(String(x?.type))) ? 'wrong-type' : 'ok';

    if (verdict === 'ok') pass++; else if (verdict === 'soft') soft++; else fail++;
    const mark = verdict === 'ok' ? '✓' : verdict === 'soft' ? '~' : '✗';
    rows.push(`${mark} ${c.want.padEnd(7)} ${String(arts.length).padStart(2)} [${types.slice(0, 28).padEnd(28)}] ${c.q.slice(0, 46)}`);
    if (verdict !== 'ok') rows.push(`      ${verdict}: ${c.why}`);
  }
  console.log('\n' + rows.join('\n'));
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${pass} right · ${fail} wrong · ${soft} answered in words where a card was allowed\n`);
  console.log('  noise      = a card on an answer that is one figure or no figure');
  console.log('  miss       = the owner asked to see it and did not get it');
  console.log('  wrong-type = a card, but not one that can carry what was asked\n');
  process.exit(fail ? 1 : 0);
})();

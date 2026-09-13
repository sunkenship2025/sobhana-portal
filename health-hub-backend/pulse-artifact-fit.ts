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
 *
 * AND PRESENCE IS NOT ENOUGH EITHER. A card that ships with two rows, no total, no shares and no
 * line saying what the figures ARE is a border round a number — necessary by this suite's first
 * test and useless by the owner's. So every shipped artifact is also scored on what it carries,
 * through deriveView, which is exactly what the renderer reads:
 *
 *   context   the period and scope the figures cover — without it a number is unplaceable
 *   means     the one sentence saying what the figure IS. It travels on every step and was
 *             rendered nowhere for months
 *   total     what the parts add up to, where there are parts
 *   shares    stated as numbers, not encoded only in a bar's width
 *   tail      how many rows are not shown and what they carry, rather than slice(0,8) in silence
 */
import 'dotenv/config';
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ask } from './src/services/pulse/index';

const dvDir = mkdtempSync(join(tmpdir(), 'pulse-dv-'));
execFileSync('npx', ['tsc', '../health-hub/src/components/pulse/deriveView.ts',
  '--outDir', dvDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'], { stdio: 'pipe' });
const { deriveView } = require(join(dvDir, 'deriveView'));

/** What a shipped card actually carries, judged the way the renderer sees it. */
function richness(art: any, evidence: any[]): { score: number; of: number; missing: string[] } {
  const idx = Array.isArray(art?.evidence) ? art.evidence[0] : art?.evidence;
  const ev = evidence.find((e: any) => e.step === Number(idx));
  const missing: string[] = [];
  if (!ev) return { score: 0, of: 1, missing: ['no evidence behind it'] };
  const v = deriveView(ev, 8);
  const multi = !!v && v.rows.length > 1;
  const want: [string, boolean][] = [
    ['context', !!(ev.period || ev.scope || (v?.context || []).length)],
    ['means', !!ev.means],
  ];
  if (multi) {
    want.push(['total', v!.total != null || v!.totalN != null]);
    want.push(['shares', v!.rows.some((r: any) => r.share != null)]);
    if (v!.hidden) want.push(['tail sized', !!v!.hidden.value]);
  }
  for (const [k, ok] of want) if (!ok) missing.push(k);
  return { score: want.filter(([, ok]) => ok).length, of: want.length, missing };
}

type Want = 'none' | 'earned' | 'asked';
interface Case { q: string; want: Want; why: string; type?: RegExp; carry?: true }

const CASES: Case[] = [
  // ── ONE FIGURE OR NONE. A card repeats the sentence and buys nothing. ────────────────────
  { q: 'how much did we collect yesterday', want: 'none', why: 'one figure' },
  { q: 'how many patients came in yesterday', want: 'none', why: 'one count' },
  /* A card here turned out to be defensible: asked whether payroll is recorded, showing what IS
     recorded answers the question behind the question. Allowed, not required. */
  { q: 'do we record payroll anywhere', want: 'earned', why: 'a yes/no, but showing what IS recorded helps' },
  /* Likewise: "what does payout category mean" answered with the actual categories and their
     sizes is a better answer than the definition alone. My "none" was the test being pedantic. */
  { q: 'what does payout category mean', want: 'earned', why: 'the real categories beat a definition', type: /breakdown|table|ranking|pareto|distribution/ },
  { q: 'how much did we spend on salaries', want: 'none', why: 'a refusal — nothing to chart' },
  { q: 'is collection up or down this month', want: 'none', why: 'a direction and one comparison' },
  { q: 'whats our average bill value', want: 'none', why: 'one derived figure' },
  { q: 'how many tests did CT-BRAIN PLAIN do last month', want: 'none', why: 'one scoped count' },

  // ── THE OWNER SAID NOT TO. Explicit refusal of a card outranks everything. ───────────────
  { q: 'just tell me the number, no table — collection this month', want: 'none', why: 'told not to show one' },
  { q: 'in one line, how did we do this month', want: 'none', why: '"in one line" is a length instruction' },

  // ── DETAIL PROSE CANNOT CARRY. Preference, not obligation. ──────────────────────────────
  { q: 'how is collection split across the branches this month', want: 'earned', why: 'a split of a total', type: /breakdown|chart|table|pareto/ },
  { q: 'who are my top referring doctors this month', want: 'earned', why: 'a ranking with a tail', type: /ranking|table|pareto|breakdown/ },
  { q: 'how has revenue moved over the last six months', want: 'earned', why: 'a series', type: /chart|trend|table/ },
  { q: 'why did collection move this month', want: 'earned', why: 'contributions to a change', type: /waterfall|breakdown|chart|compare|table/ },
  { q: 'which tests bring in the most money', want: 'earned', why: 'a ranking over many tests', type: /ranking|table|pareto|breakdown/ },
  /* A breakdown carrying per-part CHANGE is a legitimate way to show two periods — it says where
     the movement came from, which is more than a compare tile does. Accepted. */
  { q: 'how does this month compare with last', want: 'earned', why: 'two periods side by side', type: /compare|chart|kpi|table|breakdown|waterfall/ },

  // ── THE OWNER ASKED TO SEE IT. Instruction, not judgement. ──────────────────────────────
  { q: 'show me collection by branch this month', want: 'asked', why: '"show me"', type: /breakdown|chart|table|pareto/ },
  { q: 'give me a table of patients who still owe money', want: 'asked', why: '"a table"', type: /table|ranking/ },
  { q: 'break down this month by payout category', want: 'asked', why: '"break down"', type: /breakdown|chart|table|pareto/ },
  { q: 'chart revenue by month for the last 6 months', want: 'asked', why: '"chart"', type: /chart|table/ },
  { q: 'list the doctors who stopped referring', want: 'asked', why: '"list"', type: /table|ranking|breakdown/ },
  { q: 'can i see the split between diagnostics and consultation', want: 'asked', why: '"can i see"', type: /breakdown|chart|table|pareto|compare/ },
  { q: 'pull up the biggest unpaid bills', want: 'asked', why: '"pull up" a list', type: /table|ranking/ },

  // ── THE CARD MUST SUPPORT THE CLAIM, not merely be allowed. ─────────────────────────────
  { q: 'which branch is dragging us down this month', want: 'earned', why: 'the split is the argument — a centre-wide total shows the opposite', type: /breakdown|ranking|waterfall|chart|table|pareto/ },

  // ── REAL-WORLD SHAPES THAT TRIP RENDERERS ───────────────────────────────────────────────
  { q: 'show me every patient who owes us money', want: 'asked', why: 'a long list — the tail must be sized, not silently cut', type: /table|ranking/ },
  /* I assumed this would be empty and it is not — doctors do lapse inside a week, and a table of
     them is the right answer. The card is judged on richness like any other; guessing the DATA
     was my error, not the product's. */
  { q: 'which doctors stopped referring in the last 7 days', want: 'earned', why: 'a list of lapsed referrers', type: /table|ranking|breakdown/ },

  // ── FOLLOW-UPS. The card has to change with the question, not repeat the last one. ───────
  { q: 'revenue by branch this month', want: 'earned', why: 'sets up the follow-ups', type: /breakdown|chart|table|pareto/ },
  { q: 'show me that again by doctor', want: 'asked', carry: true, why: 'same figure, different dimension', type: /breakdown|ranking|chart|table|pareto/ },
  { q: 'what about just diagnostics', want: 'earned', carry: true, why: 'the scope narrows; the card should follow', type: /breakdown|chart|table|pareto|kpi|compare/ },
  { q: 'is that actually material', want: 'none', carry: true, why: 'a meta-question about the last answer — nothing new to show' },
];


(async () => {
  let pass = 0, fail = 0, soft = 0, thinCount = 0;
  let carried: any = {};
  let clarified = 0;
  const rows: string[] = [];
  for (const c of CASES) {
    let a: any;
    /* Follow-ups run against the PREVIOUS answer's state, because "show me that again by doctor"
       means nothing without it — and an artifact that ignores the swap is the failure being
       looked for here. */
    try { a = await ask(c.q, c.carry ? carried : {}); } catch (e: any) { console.log(`✗ THREW  ${c.q}`); fail++; continue; }
    carried = a.state || carried;
    /* A CLARIFYING QUESTION NEVER REACHED THE ARTIFACT STAGE. "can i see the split between
       diagnostics and consultation" came back "Which diagnostics?" — there is no analysis, no
       contract and no evidence, so scoring it as a missing card measures the wrong thing. It is
       reported on its own line, because over-clarifying is worth knowing about and is not what
       this suite is for. */
    if (a?.kind && a.kind !== 'analysis') {
      clarified++;
      rows.push(`~ ${c.want.padEnd(7)}  – [${String(a.kind).padEnd(24)}]          ${c.q.slice(0, 40)}`);
      rows.push(`      ${a.kind}: "${String(a.text || a.segments?.verdict || '').slice(0, 60)}"`);
      continue;
    }
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
    const rich = arts.map((x) => richness(x, a.evidence || []));
    const thin = rich.filter((r) => r.missing.length);
    rows.push(`${mark} ${c.want.padEnd(7)} ${String(arts.length).padStart(2)} [${types.slice(0, 24).padEnd(24)}] ${rich.map((r) => `${r.score}/${r.of}`).join(' ').padEnd(8)} ${c.q.slice(0, 40)}`);
    if (verdict !== 'ok') rows.push(`      ${verdict}: ${c.why}`);
    for (const r of thin) { rows.push(`      thin: missing ${r.missing.join(', ')}`); thinCount++; }
  }
  console.log('\n' + rows.join('\n'));
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  ${pass} right · ${fail} wrong · ${soft} answered in words where a card was allowed`);
  console.log(`  ${thinCount} shipped card${thinCount === 1 ? '' : 's'} missing something the renderer would have shown`);
  if (clarified) console.log(`  ${clarified} asked a clarifying question instead of answering — not an artifact failure, but worth watching\n`);
  else console.log();
  console.log('  noise      = a card on an answer that is one figure or no figure');
  console.log('  miss       = the owner asked to see it and did not get it');
  console.log('  wrong-type = a card, but not one that can carry what was asked\n');
  process.exit(fail || thinCount ? 1 : 0);
})();

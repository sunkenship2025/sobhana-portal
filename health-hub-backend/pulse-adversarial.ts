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
 *   FELL_BACK       V2 threw and V1 answered a different question
 *
 *   npx ts-node --transpile-only pulse-adversarial.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';
import { rowsOf } from './src/services/pulse/v2/capability';

type Check = 'FINISHED_OPEN' | 'UNSIZED_LEVER' | 'UNGROUNDED' | 'TEST_BRANCH' | 'DENIED'
  | 'FALSE_PREMISE' | 'EMPTY_ARTIFACT' | 'FELL_BACK';

interface Case { q: string; why: string; expect?: Check[]; state?: 'carry' }

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
  { q: 'how much profit did we make last month', why: 'no cost data exists anywhere' },
  { q: 'what is our biggest expense', why: 'no expense table' },
  { q: 'how much did we spend on salaries', why: 'no payroll data' },

  // things that DO exist — must not deny
  { q: 'which staff member should i review', why: 'AnomalyEvent exists; denying it is the worst answer' },
  { q: 'are patients opening the reports we send', why: 'ReportAccessLog exists' },

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
const DENY = /no field|not record|does not record|no way to|cannot see|we do not have|there is no data/i;

function evidenceNumbers(ev: any[]): number[] {
  const out: number[] = [];
  const walk = (x: any) => {
    if (x == null) return;
    if (typeof x === 'number') { if (Number.isFinite(x)) out.push(Math.abs(x)); return; }
    if (typeof x === 'string') { for (const m of x.matchAll(/-?[\d,]*\.?\d+/g)) { const n = Number(m[0].replace(/,/g, '')); if (Number.isFinite(n)) out.push(Math.abs(n)); } return; }
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'object') for (const v of Object.values(x)) walk(v);
  };
  for (const e of ev || []) { walk(e?.summary); walk(e?.data); }
  return [...out, ...out.map((n) => n / 100), ...out.map((n) => n * 100)];
}

function audit(a: any): { flags: Check[]; notes: string[] } {
  const flags: Check[] = []; const notes: string[] = [];
  const text = String(a?.segments?.verdict ? [a.segments.verdict, ...(a.segments.points || []).map((p: any) => p.text), a.segments.caveat, a.segments.action].filter(Boolean).join(' ') : a?.text || '');
  const ev = (a?.evidence || []).filter((e: any) => e.ok);

  if (!a?.trace && a?.kind === 'analysis') { flags.push('FELL_BACK'); notes.push('no trace — V2 threw'); }

  // a material claim still open when the loop stopped
  const open = (a?.trace?.investigation?.hypotheses || []).filter((h: any) => h.status === 'open' && h.material !== false);
  if (open.length && !/unproven|untested|not established|still open|cannot say|do not know|unverified/i.test(text)) {
    flags.push('FINISHED_OPEN');
    notes.push(`${open.length} material open, unacknowledged: "${open[0].claim.slice(0, 60)}"`);
  }

  // a recommendation with no number behind it
  for (const o of a?.opportunities || []) {
    if (!o.rupeeValue) { flags.push('UNSIZED_LEVER'); notes.push(`unsized: ${o.title}`); break; }
  }

  // numbers that came from nowhere
  const have = evidenceNumbers(ev);
  if (have.length) {
    const bad: string[] = [];
    for (const m of text.matchAll(NUM)) {
      const n = Number(String(m[0]).replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n) || (n <= 12 && Number.isInteger(n)) || (n >= 1900 && n <= 2100)) continue;
      if (!have.some((h) => h === n || (h !== 0 && Math.abs(h - n) / Math.max(Math.abs(h), 1) < 0.011))) bad.push(m[0]);
    }
    if (bad.length) { flags.push('UNGROUNDED'); notes.push(`invented: ${[...new Set(bad)].slice(0, 4).join(', ')}`); }
  }

  // test branches in anything that renders
  for (const e of ev) {
    const hit = rowsOf(e).some((r: any) => r && typeof r === 'object'
      && Object.values(r).some((v) => v === 'JGG' || v === 'IDPL'));
    if (hit) { flags.push('TEST_BRANCH'); notes.push(`${e.tool} rows carry a test branch`); break; }
  }

  // denying something the centre records
  if (DENY.test(text) && /staff|mistake|anomal|open|report|deliver|referr/i.test(text)) {
    flags.push('DENIED'); notes.push('claims something is not recorded');
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
    try { a = await ask(c.q, c.state === 'carry' ? state : {}, { v2: true }); }
    catch (e: any) { a = { kind: 'error', text: String(e?.message) }; }
    if (a?.state) state = a.state;
    const { flags, notes } = audit(a);
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

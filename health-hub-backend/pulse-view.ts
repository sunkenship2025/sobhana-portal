/**
 * EVERYTHING BETWEEN THE EVIDENCE AND THE OWNER'S EYES — no model calls, no browser, no database.
 *
 * deriveView is what decides whether a card is useful or, in the owner's words, "genuinely bad
 * and not usable". It is a pure function of the evidence, and it was the one part of the artifact
 * work with no test at all: the frontend lives in an ESM package the backend cannot require, so
 * it fell between the two and nothing checked it.
 *
 * The rules it exists to enforce are the ones asserted here: a share only where a total exists,
 * a tail STATED rather than silently dropped by slice(0,8), money displayed exactly as it arrived,
 * and — the rule the whole file is built on — a field that cannot justify itself is ABSENT, not
 * null, so no renderer ever prints "— %".
 *
 * It compiles the frontend file to CommonJS on the way in, which is why this needs no bundler.
 *
 * Alongside it, the three other pure layers that decide what is shown and what is said:
 * describeEvidence (what SHAPE this evidence is, read from the values and never from a whitelist
 * of column names), rankRenderers (which artifact types this evidence can TRUTHFULLY carry), and
 * the bindings (an assumption may be carried, but only a fact may be STATED — printing an
 * advisory period as "ASSUMED PERIOD" once turned ₹1,03,400 into ₹17,600).
 */
import { execFileSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const out = mkdtempSync(join(tmpdir(), 'pulse-view-'));
execFileSync('npx', ['tsc', '../health-hub/src/components/pulse/deriveView.ts',
  '--outDir', out, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'], { stdio: 'pipe' });
const { deriveView, pctOf, toNum } = require(join(out, 'deriveView'));

let pass = 0, fail = 0;
const ok = (n: string, good: boolean, d = '') => { console.log(`  ${good ? '✓' : '✗'} ${n}${good || !d ? '' : ` — ${d}`}`); good ? pass++ : fail++; };

console.log('\nartifact derivation — evidence to view\n');
const parts = { summary: { parts: [{ name: 'CNT', value: 700 }, { name: 'BLN', value: 300 }] }, means: 'net collected' };
const v = deriveView(parts)!;
ok('derives rows', v.rows.length === 2);
ok('computes shares from the summed total', Math.abs((v.rows[0].share ?? 0) - 0.7) < 1e-9);
ok('carries "means" through — the sentence saying what the figure IS', v.means === 'net collected');
ok('no given total → a totalN but no total string', v.total === undefined && v.totalN === 1000);

const withTotal = { summary: { total: '₹2,000', parts: [{ name: 'A', value: 700 }, { name: 'B', value: 300 }] } };
const v2 = deriveView(withTotal)!;
ok('a total we were GIVEN beats one we computed', v2.total === '₹2,000' && v2.totalN === 2000);
ok('shares use the given total', Math.abs((v2.rows[0].share ?? 0) - 0.35) < 1e-9);

const many = { summary: { parts: Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, value: 100 - i })) } };
const v3 = deriveView(many, 8)!;
ok('shows only the limit', v3.rows.length === 8);
ok('STATES the hidden tail rather than dropping it', v3.hidden?.count === 4);
ok('sizes the hidden tail', !!v3.hidden?.value);
ok('reports concentration — the answer to "is 9 a lot"', v3.concentration?.topN === 5);

const single = { summary: { parts: [{ name: 'only', value: 5 }] } };
const v4 = deriveView(single)!;
ok('ABSENT, NOT NULL: one row carries no concentration field', !('concentration' in v4));
ok('ABSENT, NOT NULL: one row carries no hidden field', !('hidden' in v4));
ok('no rows → null, not an empty shell', deriveView({ summary: {} }) === null);

const money = { summary: { parts: [{ name: 'CNT', value: '₹1,03,400' }, { name: 'BLN', value: '₹51,700' }] } };
const v5 = deriveView(money)!;
ok('money is displayed exactly as it arrived', v5.rows[0].value === '₹1,03,400');
ok('magnitude survives Indian formatting', v5.rows[0].n === 103400);
ok('shares computed on formatted money', Math.abs((v5.rows[0].share ?? 0) - 2 / 3) < 1e-9);

const neg = { summary: { parts: [{ name: 'up', value: 80 }, { name: 'down', value: -20 }] } };
ok('negative magnitudes use absolute value', deriveView(neg)!.rows[1].n === 20);
ok('pctOf floors a tiny share to "<1%"', pctOf(0.004) === '<1%');
ok('toNum survives junk', toNum('—') === 0 && toNum('₹1,234') === 1234);

const { describeEvidence, rankRenderers } = require('./src/services/pulse/v2/capability');
const { timeAuthority, compileBindings, formatBindings } = require('./src/services/pulse/v2/binding');
const ev = (o: any) => ({ step: 0, tool: 'x', label: 'x', ok: true, summary: {}, ...o });

console.log('\nevidence structure — read from the VALUES, never a column-name whitelist\n');
const split = describeEvidence(ev({ data: { rows: [{ k: 'CNT', v: 700 }, { k: 'BLN', v: 300 }] } }));
ok('a two-part split has one dimension and one measure', split.dimensions === 1 && split.measures === 1);
ok('a single figure has cardinality one', describeEvidence(ev({ data: { value: 5 }, summary: { value: '₹5' } })).cardinality === 'one');
const SERIES = ev({ data: { rows: [{ bucket: '2026-07', v: 1 }, { bucket: '2026-08', v: 2 }, { bucket: '2026-09', v: 3 }] } });
ok('a monthly series is a time series', describeEvidence(SERIES).isTimeSeries === true);
ok('many distinct values read as continuous', describeEvidence(ev({ data: { rows: Array.from({ length: 30 }, (_, i) => ({ k: `p${i}`, v: 100 + i * 7 })) } })).continuous === true);
ok('a per-category count does not', describeEvidence(ev({ data: { rows: Array.from({ length: 30 }, (_, i) => ({ k: `p${i}`, v: 1 })) } })).continuous === false);

console.log('\nwhich artifacts this evidence can TRUTHFULLY carry\n');
const SPLIT = ev({ data: { rows: [{ k: 'CNT', v: 700 }, { k: 'BLN', v: 300 }] } });
ok('a split can be a breakdown', rankRenderers(SPLIT, 'composition').map((c: any) => c.type).includes('breakdown'));
ok('one figure cannot be a breakdown', !rankRenderers(ev({ data: { value: 5 }, summary: { value: '₹5' } }), 'magnitude').map((c: any) => c.type).includes('breakdown'));
ok('a series can be a chart', rankRenderers(SERIES, 'trend').map((c: any) => c.type).includes('chart'));

console.log('\nbindings — an assumption may be CARRIED, but only a fact may be STATED\n');
ok('a period the owner named is authoritative', timeAuthority({ period: 'last-90-days', phrase: 'last 90 days', from: '2026-06-15', to: '2026-09-13' }) === 'authoritative');
ok('a planner default is advisory', timeAuthority({ period: 'month', from: '2026-09-01', to: '2026-09-13' }) === 'advisory');
ok('an advisory binding is never printed', !/ASSUMED|2026-09/.test(formatBindings(compileBindings({ goal: '', scope: [], time: { period: 'month', from: '2026-09-01', to: '2026-09-13' } }))));
ok('an authoritative binding IS printed', /2026-06-15|last 90 days/.test(formatBindings(compileBindings({ goal: '', scope: [], time: { period: 'last-90-days', phrase: 'last 90 days', from: '2026-06-15', to: '2026-09-13' } }))));

const { groundNumbers, unsupported } = require('./src/services/pulse/v2/grounding');
const { stagnating, comparable } = require('./src/services/pulse/v2/investigation');
const kinds = (t: string, e: any[]) => groundNumbers(t, EV).map((g: any) => `${g.text}:${g.provenance.kind}`);

console.log('\nGROUNDING — every number in prose traced to a step, or named as invented\n');
const EV = [{ step: 0, ok: true, unit: 'paise', data: { value: 10340000 }, summary: { value: '₹1,03,400' } },
            { step: 1, ok: true, unit: 'count', data: { value: 47 }, summary: { value: '47' } }];
ok('a figure straight from a step is exact', kinds('billed ₹1,03,400 in total', EV).some((k) => /exact/.test(k)), kinds('billed ₹1,03,400 in total', EV).join(' '));
ok('a figure from no step is ungrounded', kinds('billed ₹9,99,999', EV).some((k) => /ungrounded/.test(k)), kinds('billed ₹9,99,999', EV).join(' '));
ok('Indian grouping is ONE figure, not three', groundNumbers('₹19,26,897', []).length === 1, JSON.stringify(groundNumbers('₹19,26,897', []).map((g: any) => g.text)));
ok('a year is ordinary, not a claim', kinds('in September 2026', EV).every((k) => /ordinary/.test(k)), kinds('in September 2026', EV).join(' '));
ok('a small ordinal is ordinary', kinds('the top 5 branches', EV).every((k) => /ordinary/.test(k)), kinds('the top 5 branches', EV).join(' '));
ok('unsupported() returns only the invented ones', unsupported(groundNumbers('₹1,03,400 and ₹9,99,999', EV)).length === 1,
   JSON.stringify(unsupported(groundNumbers('₹1,03,400 and ₹9,99,999', EV))));
// arithmetic over two steps is derivable, not invented
const both = kinds('₹1,03,400 across 47 scans is ₹2,200 each', EV).join(' ');
ok('a per-unit figure derived from two steps is not invented', !/2,200:ungrounded/.test(both), both);

console.log('\nCONVERGENCE — stop when it stops learning, not when it runs out of rounds\n');
const R = (gain: number, state: string, req = 0, mat = 0) => ({ gain, state, requirementsSatisfied: req, resolvedMaterial: mat } as any);
ok('two rounds is never enough to judge', stagnating([R(0, 'a'), R(0, 'a')]) === false);
ok('three rounds of no gain is stagnation', stagnating([R(0, 'a'), R(0, 'a'), R(0, 'a')]) === true);
// NOVELTY IS NOT PROGRESS — deliberate, and justified by five real runs: a query can succeed,
// return rows nobody asked for, settle nothing, and still score a positive gain.
ok('gain alone, settling nothing, IS stagnation', stagnating([R(0, 'a'), R(2, 'b'), R(0, 'c')]) === true);
ok('unchanged belief with nothing resolved is stagnation', stagnating([R(1, 'same'), R(1, 'same'), R(1, 'same')]) === true);
ok('recovery counts as progress', stagnating([R(0, 'a'), R(0, 'b'), R(0, 'c', 0, 2)]) === false, 'a repaired step advanced the investigation');

console.log('\nCOMPARABILITY — two figures held up as like for like\n');
ok('same period and scope are comparable', comparable({ period: 'p', scope: 's', metric: 'm' } as any, { period: 'p', scope: 's', metric: 'm' } as any).verdict === 'comparable');
ok('different periods are not', comparable({ period: 'jul', scope: 's' } as any, { period: 'aug', scope: 's' } as any).verdict === 'different');
ok('too little identity is unknown, not a pass', comparable({ period: 'p' } as any, {} as any).verdict === 'unknown');

console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls, no browser, no database\n`);
process.exit(fail ? 1 : 0);

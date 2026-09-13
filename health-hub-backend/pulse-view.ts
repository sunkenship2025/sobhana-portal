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

console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls, no browser, no database\n`);
process.exit(fail ? 1 : 0);

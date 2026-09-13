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

const { groupedBy, periodOf, filtersOf, orderedBy, exposedIdentifiers } = require('./src/services/pulse/v2/sqlscope');
const SQL_FROM = `FROM "TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=v."branchId"`;

console.log('\nPERIOD — read off the SQL, because a period is a property of the query that RAN\n');
ok('an explicit window is read', !!periodOf(`SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= '2026-06-15' AND o."createdAt" < '2026-09-13'`),
   String(periodOf(`SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= '2026-06-15' AND o."createdAt" < '2026-09-13'`)));
ok('no time predicate → NO period, not a guess', periodOf(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`) === undefined,
   String(periodOf(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`)));
ok('a relative window is a period', !!periodOf(`SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= CURRENT_DATE - 90`),
   String(periodOf(`SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= CURRENT_DATE - 90`)));
ok('a date inside an UNREFERENCED CTE is not the period',
   periodOf(`WITH x AS (SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= '2020-01-01') SELECT SUM(o."priceInPaise") ${SQL_FROM}`) === undefined,
   String(periodOf(`WITH x AS (SELECT 1 ${SQL_FROM} WHERE o."createdAt" >= '2020-01-01') SELECT SUM(o."priceInPaise") ${SQL_FROM}`)));

console.log('\nGROUPING — what KIND of thing each row is\n');
const g = groupedBy(`SELECT o."payoutCategorySnapshot" k, SUM(o."priceInPaise") v ${SQL_FROM} GROUP BY 1`);
ok('a GROUP BY column is found', g.length > 0, JSON.stringify(g));
ok('no GROUP BY → no keys', groupedBy(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`).length === 0);

console.log('\nFILTERS AND ORDER — what the query actually restricted, and how it ranked\n');
ok('a WHERE value is reported', /CTBP/i.test(String(filtersOf(`SELECT 1 ${SQL_FROM} WHERE o."testCodeSnapshot" = 'CTBP'`))),
   String(filtersOf(`SELECT 1 ${SQL_FROM} WHERE o."testCodeSnapshot" = 'CTBP'`)));
ok('no WHERE → no filter label', filtersOf(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`) === undefined);
const o1 = orderedBy(`SELECT o."testCodeSnapshot" k, SUM(o."priceInPaise") v ${SQL_FROM} GROUP BY 1 ORDER BY 2 DESC`);
ok('descending order is seen as descending', o1?.desc === true, JSON.stringify(o1));
ok('no ORDER BY → null', orderedBy(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`) === null);

console.log('\nEXPOSED IDENTIFIERS — what a row would reveal about a person\n');
const x = exposedIdentifiers(`SELECT p."patientNumber", p.name ${SQL_FROM} JOIN "Patient" p ON p.id=v."patientId"`);
ok('patient identifiers are detected', x.parsed && x.exposed.length > 0, JSON.stringify(x));
const y = exposedIdentifiers(`SELECT SUM(o."priceInPaise") ${SQL_FROM}`);
ok('an aggregate exposes nobody', y.parsed && y.exposed.length === 0, JSON.stringify(y));

const { identityOf } = require('./src/services/pulse/v2/artifacts');
console.log('\nROW IDENTITY — what to call a row when the owner says "name him"\n');
ok('a human-readable key beats a surrogate id',
   identityOf({ id: 'cmf6q2x9k0001abcd', patientNumber: 'P-000594', name: 'ABDUL SALEEM' })?.value !== 'cmf6q2x9k0001abcd',
   JSON.stringify(identityOf({ id: 'cmf6q2x9k0001abcd', patientNumber: 'P-000594', name: 'ABDUL SALEEM' })));
ok('a name row identifies by name',
   /ABDUL/i.test(String(identityOf({ name: 'ABDUL SALEEM', v: 12 })?.value)),
   JSON.stringify(identityOf({ name: 'ABDUL SALEEM', v: 12 })));
ok('a row with nothing identifying returns null', identityOf({ v: 12, n: 3 }) === null, JSON.stringify(identityOf({ v: 12, n: 3 })));

/* THE MODEL CAN ONLY USE WHAT THE PROMPT TELLS IT EXISTS. Generation needs the model; its INPUT
   does not — and a metric absent from the prompt may as well not exist, however correctly it is
   implemented. `compute` shipped in the planner catalogue while the INVESTIGATOR, which plans
   every round after the first and is where the operands actually land, never saw a tool list at
   all: it went on answering "the share itself was never computed" with both operands on the
   table. That was invisible for a day, and it is one assertion here. */
const { PLAN_SYS, INVESTIGATE_SYS, RESPOND_SYS } = require('./src/services/pulse/v2/analyst');
const { METRIC_BLOCK, METRIC_DIMS, METRICS } = require('./src/services/pulse/catalog');
const { contractFor } = require('./src/services/pulse/v2/contract');
const PLAN = PLAN_SYS(), INV = INVESTIGATE_SYS();
const RESP = RESPOND_SYS({ ...contractFor('magnitude'), canShow: ['kpi'] });

console.log('\nwhat the model is told exists\n');
for (const m of ['billed_on_orders', 'commission_on_orders']) {
  ok(`${m} reaches the planner`, PLAN.includes(m));
  ok(`${m} is filterable and has a FROM`, !!METRIC_DIMS[m] && !!METRICS[m]);
}
ok('compute is offered to the planner', /\bcompute\b/.test(PLAN));
ok('compute is offered to the INVESTIGATOR, where operands land', /"tool":"compute"/.test(INV));
ok('derive advertises its filter', /derive\s+\{numerator, denominator, period, filter\}/.test(PLAN));

console.log('\nthe rules that cost real money are still in the text\n');
ok('payback divides capital by CONTRIBUTION, not gross', /divides capital by contribution/i.test(INV));
ok('operands must share a basis', /same basis/i.test(INV));
ok('complete:false QUALIFIES an answer, never replaces one', /does not replace one/i.test(RESP));
ok('the writer is still forbidden to compute', /never compute or invent a number/i.test(RESP));
ok('and is told where arithmetic belongs instead', /"compute" step is for/i.test(RESP));
ok('test branches stay out of findings', /JGG|IDPL/.test(RESP));

console.log('\nno prompt is malformed\n');
for (const [n, p] of [['plan', PLAN], ['investigate', INV], ['respond', RESP]] as [string, string][]) {
  ok(`${n} is substantial`, p.length > 1200, `${p.length} chars`);
  ok(`${n} has no unresolved template holes`, !/\$\{|\bundefined\b|\[object Object\]/.test(p),
     (p.match(/\$\{[^}]*\}|undefined|\[object Object\]/) || [''])[0]);
}
ok('the metric block lists every metric', Object.keys(METRICS).every((m) => METRIC_BLOCK.includes(m)),
   Object.keys(METRICS).filter((m) => !METRIC_BLOCK.includes(m)).join(','));

/* THE OWNER ASKED NOT TO BE BLOCKED FROM PULLING LISTS, AND THAT IS AN AUTHORIZATION DECISION
   RATHER THAN A PROPERTY OF THE QUERY. It is made at the route, where the asker is known, and
   passed down as policy — the route is requireRole('owner'), so row-level detail about their own
   patients is theirs to see. Pinned in both directions, because this is the one guard where
   being wrong in one direction exposes a patient and being wrong in the other silently refuses
   the owner their own data, which is what prompted the instruction. */
const { validate } = require('./src/services/pulse/validator');
/* No aggregate across the one-to-many join: a plain list of rows, which is what "pull me a
   list" means and what the fan-out guard — a different rule entirely — would otherwise catch
   first, masking whether the row-level policy said yes. */
const NAMES_SQL = `SELECT p.name, p."patientNumber", b."totalAmountInPaise" AS due
  FROM "Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Patient" p ON p.id=v."patientId"
  ORDER BY b."totalAmountInPaise" DESC LIMIT 20`;
const COUNT_SQL = `SELECT COUNT(DISTINCT p.id) n FROM "Patient" p`;

console.log('\nwho may see a patient by name\n');
ok('the owner may pull a list of names', validate(NAMES_SQL, { rowLevel: true }) === null,
   String(validate(NAMES_SQL, { rowLevel: true })));
ok('a surface without that right may not', typeof validate(NAMES_SQL, { rowLevel: false }) === 'string');
ok('  and the refusal names the columns', /identifying columns/.test(String(validate(NAMES_SQL, { rowLevel: false }))),
   String(validate(NAMES_SQL, { rowLevel: false })).slice(0, 70));
ok('counting patients is a measurement, not a disclosure', validate(COUNT_SQL, { rowLevel: false }) === null,
   String(validate(COUNT_SQL, { rowLevel: false })));
ok('default policy does not block the owner', validate(NAMES_SQL, {}) === null, String(validate(NAMES_SQL, {})));

console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls, no browser, no database\n`);
process.exit(fail ? 1 : 0);

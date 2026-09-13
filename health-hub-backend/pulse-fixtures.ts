/**
 * REAL EVIDENCE, CAPTURED FOR THE ARTIFACT GALLERY — no model calls.
 *
 * The first version of the gallery used evidence I wrote by hand, and three cards rendered wrong.
 * I could not tell whether that was the renderer or my mock, and hand-written fixtures are the
 * classic way to file bugs against your own imagination: the mock mixed paise and rupees, which
 * no real step ever does.
 *
 * So the fixtures come from the registry tools themselves, against the live database. Every shape
 * is exactly what the renderers actually receive.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { ensureKnowledge } from './src/services/pulse/knowledge';
import { runStep } from './src/services/pulse/v2/tools';

(async () => {
  const k = await ensureKnowledge();
  const steps: [string, any][] = [
    ['kpi / compare', { tool: 'compare', args: { metric: 'revenue', period: 'month' } }],
    ['breakdown',     { tool: 'breakdown', args: { metric: 'revenue', dimension: 'branch', period: 'month' } }],
    ['ranking / pareto / distribution', { tool: 'rank', args: { metric: 'test_orders', dimension: 'referring_doctor', period: 'last-30-days', limit: 12 } }],
    ['chart',         { tool: 'trend', args: { metric: 'revenue', bucket: 'month', buckets: 6 } }],
    ['table',         { tool: 'worklist', args: { kind: 'dues', limit: 6, sort: 'largest' } }],
  ];
  /* REDACTED ON THE WAY OUT. The dues worklist returns real patients — names, phone numbers,
     bill numbers — and a fixture file is a thing that gets committed, shared and forgotten. The
     renderers do not care what the strings SAY, only that a row has a label and a figure, so
     nothing is lost by replacing identifiers with stand-ins. Structure is the fixture; identity
     is not. */
  const NAMES = ['A. KUMAR', 'S. REDDY', 'M. IYER', 'R. KHAN', 'P. NAIR', 'V. RAO', 'T. SHETTY', 'N. BOSE'];
  const IDENT = /name|patient|phone|mobile|contact|email|bill|invoice|address|doctor|referr/i;
  let seq = 0;
  const redact = (v: any, key: string): any => {
    if (typeof v !== 'string' || !IDENT.test(key)) return v;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v;                  // a date is not an identifier
    /* NOR IS A CODE. `name` is the key a breakdown uses for its PARTS, so redacting on the key
       alone turned the branches CNT and BLN into "A. KUMAR" — a card about two branches
       presented as a card about two people. A person's name has a lowercase letter or a space;
       a short all-caps token is a code and stays. */
    if (/^[A-Z0-9][A-Z0-9_\-\/]{0,5}$/.test(v)) return v;
    if (/^\d[\d\s-]{7,}$/.test(v)) return '90000 00000';
    if (/^[A-Z]-[A-Z]{3}-\d+$/i.test(v)) return 'D-XXX-000000';
    if (/^P-\d+$/i.test(v)) return `P-${String(100000 + (seq % 900)).slice(0, 6)}`;
    return NAMES[seq++ % NAMES.length];
  };
  const scrub = (x: any, key = ''): any =>
    Array.isArray(x) ? x.map((i) => scrub(i, key))
      : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v, k)]))
      : redact(x, key);

  const out: any[] = [];
  for (let i = 0; i < steps.length; i++) {
    const [why, s] = steps[i];
    const e: any = await runStep(s, i, k, null, {}, [], 'gallery fixture');
    console.log(`  ${e.ok ? '✓' : '✗'} ${String(why).padEnd(34)} ${e.ok ? JSON.stringify(e.summary).slice(0, 92) : e.error}`);
    out.push({ step: i, tool: e.tool, label: e.label, ok: e.ok, unit: e.unit ?? null, dimension: e.dimension ?? null,
      period: e.period ?? null, scope: e.scope ?? null, means: e.means ?? null,
      summary: scrub(e.summary ?? null), data: scrub(e.data ?? null) });
  }
  const path = '../health-hub/src/dev/fixtures.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\n  wrote ${out.length} real evidence steps to ${path}\n`);
})();

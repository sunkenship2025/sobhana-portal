/**
 * Seed HealthContentRule from smart-report-content.csv + the global config row.
 *
 *   npx tsx prisma/seed-smart-report-content.ts --dry     validate only, no DB
 *   npx tsx prisma/seed-smart-report-content.ts           upsert
 *
 * Lints as it goes:
 *   - what_it_means must contain NO digits (numbers are rendered from data and
 *     would go stale + trip the AI validator's grounding check)
 *   - no gendered phrasing (ranges are rendered separately; Gender=O exists)
 *   - tier 2 rows should carry at least one piece of advice
 *   - every diet_dont must READ as a prohibition. They render under a cross, so a
 *     row like "Mention any B12 supplement to your doctor" told the patient the
 *     opposite of what was meant. Caught once; now it cannot ship again.
 */
import fs from 'node:fs';
import path from 'node:path';

const CSV = path.resolve(__dirname, '../../smart-report-content.csv');
const DRY = process.argv.includes('--dry');

/** A dont-line must actually forbid something; it is rendered beside a cross. */
const PROHIBITION = /^(avoid|limit|cut down|do not|don't|reduce|stop|skip|no )/i;

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

/** Digits that are part of an analyte NAME are fine; digits that are a VALUE are not. */
const NAME_DIGITS = /\b(B12|T3|T4|FT3|FT4|A1c|HbA1c|25-OH|O2|CO2|COVID-19)\b/gi;
/** Only flag gendering aimed at the PATIENT — "male sex hormone" is a factual descriptor. */
const GENDERED = /\b(for (adult )?(men|women)|in (men|women)\b|your (his|her))\b/i;

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    const id = `${r.language}/${r.test_code}/${r.direction}`;
    if (!r.test_code || !r.direction) { problems.push(`${id}: missing code/direction`); continue; }
    if (seen.has(id)) problems.push(`${id}: duplicate row`);
    seen.add(id);
    if (!r.what_it_means) problems.push(`${id}: empty what_it_means`);
    if (/\d/.test(r.what_it_means.replace(NAME_DIGITS, ''))) {
      problems.push(`${id}: what_it_means contains a numeric value — numbers are rendered from data`);
    }
    if (GENDERED.test(r.what_it_means)) problems.push(`${id}: what_it_means is gendered`);
    if (r.what_it_means.length > 220) problems.push(`${id}: what_it_means too long`);
    if (r.tier === '2' && !r.diet_do && !r.diet_dont && !r.lifestyle && !r.follow_up_test_codes) {
      problems.push(`${id}: tier 2 with no advice`);
    }
    // A dont-line renders under a cross. One row read "Mention any B12 supplement
    // to your doctor", which told the patient the opposite of what was meant.
    if (r.diet_dont && !PROHIBITION.test(r.diet_dont.trim())) {
      problems.push(`${id}: diet_dont does not read as a prohibition — it renders under a cross`);
    }
  }

  console.log(`${rows.length} rows, ${problems.length} problems`);
  for (const p of problems.slice(0, 25)) console.log('  ✗', p);
  if (problems.length) process.exitCode = 1;
  if (DRY) { console.log(problems.length ? 'DRY RUN — fix the above' : 'DRY RUN — clean'); return; }
  if (problems.length) { console.log('refusing to seed with problems'); return; }

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const list = (v: string) => (v ? v.split('|').map((x) => x.trim()).filter(Boolean) : []);

  for (const r of rows) {
    const data = {
      language: r.language || 'en',
      testCode: r.test_code,
      direction: r.direction,
      tier: Number(r.tier) || 1,
      title: r.title,
      whatItMeans: r.what_it_means,
      dos: r.diet_do ? [r.diet_do] : [],
      donts: r.diet_dont ? [r.diet_dont] : [],
      lifestyle: r.lifestyle ? [r.lifestyle] : [],
      suggestedTestCodes: r.follow_up_test_codes
        ? r.follow_up_test_codes.split(',').map((x) => x.trim()).filter(Boolean) : [],
      followUpWeeks: r.follow_up_weeks ? Number(r.follow_up_weeks) : null,
      severity: r.severity || 'STANDARD',
    };
    await prisma.healthContentRule.upsert({
      where: { language_testCode_direction: { language: data.language, testCode: data.testCode, direction: data.direction } },
      create: data as any,
      update: data as any,
    });
  }

  const existing = await prisma.smartReportConfig.findFirst({ where: { branchId: null } });
  if (!existing) {
    await prisma.smartReportConfig.create({ data: { branchId: null, enabled: false } });
    console.log('created global SmartReportConfig (enabled = false)');
  }

  console.log(`seeded ${rows.length} content rules`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

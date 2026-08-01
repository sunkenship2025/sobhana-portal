/**
 * seed-referral-categories.ts  (untracked, run-on-demand — NOT auto-run on deploy)
 *
 * One-time "auto add" for the referral-category feature. Run AFTER applying the
 * 20260801000000_add_referral_categories migration, BEFORE the resolver change
 * starts taking effect on live billing — otherwise referred bills fall to ₹0
 * because there's no rate card yet.
 *
 *   1. Backfill ClinicalPanel.payoutCategory for panels that have none, by
 *      name-inference (Lab / X-Ray / USG / ECG / CT-MRI), exactly like the
 *      payout statement already guesses today.
 *   2. Seed the ReferralCategoryRate rate card at 50% for every category —
 *      matching the OLD per-doctor flat default, so commissions are unchanged at
 *      go-live. The owner then edits each category's real rate in the UI.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   npx tsx prisma/seed-referral-categories.ts            # preview
 *   npx tsx prisma/seed-referral-categories.ts --apply    # write
 */
import { PrismaClient } from '@prisma/client';
import { categorize, CATEGORY_ORDER } from '../src/services/payoutCategorize';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Continuity default: the referral flat default used to be 50%. Seed every
// category at 50% PERCENTAGE so behaviour is identical the moment this ships.
const SEED_PERCENT = 50;

async function main() {
  console.log(APPLY ? '── APPLY MODE (writing) ──' : '── DRY RUN (no writes; pass --apply) ──');

  // 1. Backfill panel categories ------------------------------------------------
  const panels = await prisma.clinicalPanel.findMany({
    where: { payoutCategory: null },
    select: { id: true, name: true, displayName: true },
  });

  const plan = panels.map((p) => ({
    id: p.id,
    label: p.displayName || p.name,
    category: categorize({ productName: p.displayName || p.name }),
  }));

  const byCat = new Map<string, number>();
  for (const row of plan) byCat.set(row.category, (byCat.get(row.category) ?? 0) + 1);

  console.log(`\nPanels missing a category: ${panels.length}`);
  for (const [cat, n] of byCat) console.log(`  ${cat}: ${n}`);
  console.log('  Sample:');
  for (const row of plan.slice(0, 12)) console.log(`    "${row.label}" → ${row.category}`);

  // 2. Seed the rate card -------------------------------------------------------
  const existingRates = await prisma.referralCategoryRate.findMany({ select: { category: true } });
  const existing = new Set(existingRates.map((r) => r.category));
  const toSeed = CATEGORY_ORDER.filter((c) => !existing.has(c));

  console.log(`\nRate card — existing: [${[...existing].join(', ') || 'none'}]`);
  console.log(`Rate card — will seed at ${SEED_PERCENT}%: [${toSeed.join(', ') || 'none'}]`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to write.');
    return;
  }

  let panelUpdates = 0;
  for (const row of plan) {
    await prisma.clinicalPanel.update({
      where: { id: row.id },
      data: { payoutCategory: row.category },
    });
    panelUpdates++;
  }

  for (const category of toSeed) {
    await prisma.referralCategoryRate.create({
      data: { category, commissionType: 'PERCENTAGE', commissionPercent: SEED_PERCENT, isActive: true },
    });
  }

  console.log(`\n✓ Backfilled ${panelUpdates} panel categories.`);
  console.log(`✓ Seeded ${toSeed.length} rate-card rows at ${SEED_PERCENT}%.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

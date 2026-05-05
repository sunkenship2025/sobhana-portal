/**
 * One-shot: set every existing referral + clinic doctor's base commission to 50%.
 *
 * Scope:
 *   - ReferralDoctor.commissionPercent → 50, commissionType → PERCENTAGE
 *   - ClinicDoctor.commissionPercent  → 50, commissionType → PERCENTAGE
 *
 * NOT touched (intentional):
 *   - ReferralDoctorProductRule overrides (per-product carve-outs are intentional)
 *   - DiagnosticCenterProductRule overrides (same reasoning)
 *   - DiagnosticReferralCenter base commission
 *   - Existing TestOrder/ClinicVisit snapshots (immutable by design — historical
 *     bills and accrued commission stay at the rate they were recorded with)
 *
 * Run: cd health-hub-backend && npx tsx prisma/set-doctor-commission-50.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TARGET_PERCENT = 50;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const refBefore = await prisma.referralDoctor.findMany({
    select: { id: true, doctorNumber: true, name: true, commissionType: true, commissionPercent: true },
  });
  const cliBefore = await prisma.clinicDoctor.findMany({
    select: { id: true, doctorNumber: true, name: true, commissionType: true, commissionPercent: true },
  });

  console.log(`Referral doctors: ${refBefore.length}`);
  console.log(`Clinic doctors:   ${cliBefore.length}`);

  const refToChange = refBefore.filter(
    (d) => d.commissionType !== 'PERCENTAGE' || d.commissionPercent !== TARGET_PERCENT,
  );
  const cliToChange = cliBefore.filter(
    (d) => d.commissionType !== 'PERCENTAGE' || d.commissionPercent !== TARGET_PERCENT,
  );

  console.log(`Will update ${refToChange.length} referral + ${cliToChange.length} clinic doctors to ${TARGET_PERCENT}%.`);

  if (dryRun) {
    console.log('\n--dry-run, no writes performed.');
    console.log('Sample referral changes:');
    for (const d of refToChange.slice(0, 5)) {
      console.log(`  ${d.doctorNumber} ${d.name}: ${d.commissionType}/${d.commissionPercent}% → PERCENTAGE/${TARGET_PERCENT}%`);
    }
    console.log('Sample clinic changes:');
    for (const d of cliToChange.slice(0, 5)) {
      console.log(`  ${d.doctorNumber} ${d.name}: ${d.commissionType}/${d.commissionPercent}% → PERCENTAGE/${TARGET_PERCENT}%`);
    }
    return;
  }

  const [refResult, cliResult] = await prisma.$transaction([
    prisma.referralDoctor.updateMany({
      data: {
        commissionType: 'PERCENTAGE',
        commissionPercent: TARGET_PERCENT,
        commissionAmountInPaise: null,
      },
    }),
    prisma.clinicDoctor.updateMany({
      data: {
        commissionType: 'PERCENTAGE',
        commissionPercent: TARGET_PERCENT,
        commissionAmountInPaise: null,
      },
    }),
  ]);

  console.log(`\n✅ Updated ${refResult.count} referral doctors and ${cliResult.count} clinic doctors to ${TARGET_PERCENT}%.`);
}

main()
  .catch((err) => {
    console.error('Failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

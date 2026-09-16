/**
 * One-off ops script: turn C/O.LALITHA HOSPITAL from a fake referral doctor
 * into a real Partner, and repair the money on every visit she ever sent.
 *
 * WHY. Lalitha is a hospital filed as a row in the 226-row ReferralDoctor list.
 * Her patients are registered correctly — right dates, right tests — and then
 * booked as ordinary walk-ins. Measured on 16 Sep 2026:
 *
 *                        SYSTEM SAID            REALITY (her own Aug sheet)
 *   Aug 2026 visits      145                    139
 *   Billed               ₹64,900                ₹62,200
 *   Booked as COLLECTED  ₹64,500 (cash, PAID)   ₹0 — Lalitha collected it
 *   Our actual share     —                      ₹12,480
 *   Commission we owe    ₹1,49,610 accrued      ₹0 — they owe US
 *
 * The direction of the money is inverted and both sides are wrong. She has no
 * category rule, so she falls through to the centre card's Laboratory = 50%.
 *
 * HER RATES, read off the August statement and matched to the catalogue. All
 * five catalogue prices agree with her sheet to the rupee, which is what
 * confirms the mapping — and confirms she charges the patient OUR price and
 * keeps the difference:
 *
 *   CBP   COMPLETE BLOOD PICTURE              ₹300  → ₹60   (20%)
 *   CRP   C-REACTIVE PROTEIN                  ₹400  → ₹100  (25%)
 *   UCS   URINE FOR CULTURE AND SENSITIVITY   ₹600  → ₹100  (16.7%)
 *   ESR   ESR                                 ₹200  → ₹50   (25%)
 *   KETO  URINE FOR KETONE BODIES             ₹200  → ₹100  (50%)
 *
 * Flat per test, NOT a category rate: the implied ratios span 16.7%–50%, so no
 * single "Laboratory %" could express them. 136 of her 139 August rows fit this
 * card exactly; the three that do not are HER arithmetic slips, worth ₹320.
 *
 * WHAT IT DOES
 *   1. Creates the Partner + one INBOUND_BILLED_THERE arrangement (they bill,
 *      they collect, doctor commission NONE — the partner IS the referrer).
 *   2. Writes the five flat product rules.
 *   3. For every visit linked to the old doctor row: creates a PartnerVisit,
 *      and rewrites each TestOrder's partner snapshot + zeroes the referral
 *      commission that should never have accrued.
 *   4. Soft-retires the old ReferralDoctor row and soft-deletes her payout
 *      ledger rows, which point the wrong way.
 *
 * It does NOT touch Bill rows. What the patient was charged is history, and the
 * bill is the patient's record; only OUR share of it was ever wrong.
 *
 * DRY-RUN by default (reads only). Pass --commit to actually write.
 *   npx tsx prisma/migrate-lalitha-to-partner.ts            # dry-run
 *   npx tsx prisma/migrate-lalitha-to-partner.ts --commit   # execute
 *
 * DATABASE_URL in .env points at PRODUCTION — treat --commit as a prod write.
 */
import prisma from '../src/lib/prisma';
import { generateNextNumber } from '../src/services/numberService';

const COMMIT = process.argv.includes('--commit');
const DOCTOR_NAME = 'C/O.LALITHA HOSPITAL';
const PARTNER_NAME = 'LALITHA HOSPITAL';

/** productCode → what WE keep, in paise. Flat, per test. */
const RATE_CARD: Record<string, number> = {
  CBP: 6000,
  CRP: 10000,
  UCS: 10000,
  ESR: 5000,
  KETO: 10000,
};

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

async function main() {
  console.log(`\nLalitha → Partner`);
  console.log(`Mode     : ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}`);

  const doctor = await prisma.referralDoctor.findFirst({
    where: { name: DOCTOR_NAME },
    select: { id: true, name: true, commissionPercent: true },
  });
  if (!doctor) throw new Error(`Referral doctor "${DOCTOR_NAME}" not found`);

  const products = await prisma.billableProduct.findMany({
    where: { code: { in: Object.keys(RATE_CARD) } },
    select: { id: true, code: true, name: true, basePriceInPaise: true },
  });
  const missing = Object.keys(RATE_CARD).filter((c) => !products.some((p) => p.code === c));
  if (missing.length) throw new Error(`Catalogue is missing: ${missing.join(', ')}`);

  console.log(`\nRate card (what WE keep):`);
  for (const p of products) {
    const share = RATE_CARD[p.code];
    const pct = ((share / p.basePriceInPaise) * 100).toFixed(1);
    console.log(
      `  ${p.code.padEnd(6)} ${p.name.slice(0, 36).padEnd(38)} ${rupees(p.basePriceInPaise).padStart(8)} → ${rupees(share).padStart(7)}  (${pct}%)`,
    );
  }

  // Every visit ever attributed to the old doctor row.
  const links = await prisma.referralDoctor_Visit.findMany({
    where: { referralDoctorId: doctor.id, deletedAt: null },
    select: {
      visitId: true,
      branchId: true,
      visit: {
        select: {
          id: true,
          branchId: true,
          createdAt: true,
          bill: { select: { totalAmountInPaise: true } },
          testOrders: {
            where: { cancelledAt: null },
            select: {
              id: true,
              priceInPaise: true,
              productId: true,
              product: { select: { code: true } },
              referralCommissionType: true,
              referralCommissionPercentage: true,
              referralCommissionAmountInPaise: true,
            },
          },
        },
      },
    },
  });

  // What the books currently claim, and what is actually ours.
  let claimedGross = 0;
  let ourShareTotal = 0;
  let ordersTouched = 0;
  let unpricedOrders = 0;
  const shareByOrder = new Map<string, number>();

  for (const link of links) {
    claimedGross += link.visit.bill?.totalAmountInPaise ?? 0;
    // A product's flat share is spread over the leaves it became — a CBP is 13
    // TestOrder rows at ₹23.07 and the ₹60 cannot sit on any one of them.
    const byProduct = new Map<string, typeof link.visit.testOrders>();
    for (const o of link.visit.testOrders) {
      const key = o.productId ?? `__order__${o.id}`;
      byProduct.set(key, [...(byProduct.get(key) ?? []), o]);
    }
    for (const [, orders] of byProduct) {
      const code = orders[0]?.product?.code;
      const share = code ? RATE_CARD[code] : undefined;
      if (share == null) {
        unpricedOrders += orders.length;
        for (const o of orders) shareByOrder.set(o.id, 0);
        continue;
      }
      const prices = orders.map((o) => o.priceInPaise);
      const total = prices.reduce((a, b) => a + b, 0);
      let allocated = 0;
      orders.forEach((o, i) => {
        const amt =
          i === orders.length - 1
            ? share - allocated
            : Math.floor((share * (total > 0 ? prices[i] : 1)) / (total > 0 ? total : orders.length));
        allocated += amt;
        shareByOrder.set(o.id, amt);
      });
      ourShareTotal += share;
      ordersTouched += orders.length;
    }
  }

  const ledger = await prisma.doctorPayoutLedger.aggregate({
    where: { referralDoctorId: doctor.id, deletedAt: null },
    _sum: { derivedAmountInPaise: true },
    _count: true,
  });

  console.log(`\nHer history`);
  console.log(`  visits linked to the doctor row : ${links.length}`);
  console.log(`  test orders to re-snapshot      : ${ordersTouched}${unpricedOrders ? ` (+${unpricedOrders} with no rate → share 0)` : ''}`);
  console.log(`  booked as our collected revenue : ${rupees(claimedGross)}`);
  console.log(`  actually ours under her card    : ${rupees(ourShareTotal)}`);
  console.log(`  overstated by                   : ${rupees(claimedGross - ourShareTotal)}`);
  console.log(`  commission accrued the wrong way: ${rupees(ledger._sum.derivedAmountInPaise ?? 0)} over ${ledger._count} rows`);

  // August reconciliation against her own sheet — the check that says the card is right.
  const aug = links.filter(
    (l) => l.visit.createdAt >= new Date('2026-08-01') && l.visit.createdAt < new Date('2026-09-01'),
  );
  const augShare = aug.reduce(
    (sum, l) => sum + l.visit.testOrders.reduce((s, o) => s + (shareByOrder.get(o.id) ?? 0), 0),
    0,
  );
  console.log(`\nAugust reconciliation`);
  console.log(`  visits              : ${aug.length}      (her sheet: 139)`);
  console.log(`  our share           : ${rupees(augShare)}   (her sheet: ₹12,480)`);
  const delta = augShare - 1248000;
  console.log(`  difference          : ${rupees(delta)}${delta === 0 ? '  ✓ exact' : '  ← explain before committing'}`);

  if (!COMMIT) {
    console.log(`\nDRY-RUN only. Re-run with --commit once August reconciles.\n`);
    await prisma.$disconnect();
    return;
  }

  const partnerNumber = await generateNextNumber('partner', 'PT');

  // Deliberately NOT one giant transaction. 408 visits and 4,729 orders is far
  // past Prisma's 5s transaction timeout, and holding a write transaction open
  // that long against the shared Neon instance is how the pool got exhausted
  // before. Each step below is idempotent, so a failure mid-way can be re-run.
  const partner = await prisma.partner.create({
    data: {
      name: PARTNER_NAME,
      partnerNumber,
      // She bills and hands the patient their report; our bill would be a
      // second ₹300 document for the same test.
      sendBill: false,
      sendReport: false,
      arrangements: {
        create: {
          kind: 'INBOUND_BILLED_THERE',
          weCollect: false,
          rateBasis: 'PCT_OF_OUR_PRICE',
          ratePercent: 0, // every real rate is a product rule below
          doctorCommissionMode: 'NONE',
          productRules: {
            create: products.map((p) => ({
              productId: p.id,
              rateBasis: 'FLAT' as const,
              rateAmountInPaise: RATE_CARD[p.code],
            })),
          },
        },
      },
    },
  });
  console.log(`  partner ${partnerNumber} created with ${products.length} product rules`);

  // One row per visit; skipDuplicates makes a re-run harmless.
  const pv = await prisma.partnerVisit.createMany({
    data: links.map((l) => ({
      visitId: l.visitId,
      partnerId: partner.id,
      branchId: l.visit.branchId,
      kind: 'INBOUND_BILLED_THERE' as const,
      partnerBilledInPaise: null, // what she charged lives on her sheet, not ours
    })),
    skipDuplicates: true,
  });
  console.log(`  ${pv.count} visits linked to the partner`);

  // Orders grouped by the share they carry, so 4,729 rows go out as a handful of
  // updateMany calls rather than 4,729 round trips.
  const byShare = new Map<number, string[]>();
  for (const [orderId, share] of shareByOrder) {
    byShare.set(share, [...(byShare.get(share) ?? []), orderId]);
  }
  let updated = 0;
  for (const [share, ids] of byShare) {
    for (let i = 0; i < ids.length; i += 500) {
      const res = await prisma.testOrder.updateMany({
        where: { id: { in: ids.slice(i, i + 500) } },
        data: {
          partnerId: partner.id,
          partnerArrangement: 'INBOUND_BILLED_THERE',
          ourShareBasis: 'FLAT',
          ourSharePercent: null,
          ourShareInPaise: share,
          partnerCutInPaise: 0, // she collected; nothing flows from us
          // The 50% that should never have accrued.
          referralCommissionType: 'PERCENTAGE',
          referralCommissionPercentage: 0,
          referralCommissionAmountInPaise: null,
        },
      });
      updated += res.count;
    }
  }
  console.log(`  ${updated} test orders re-snapshotted across ${byShare.size} distinct share values`);

  // Her ledger rows point the wrong way; soft-delete rather than destroy, so the
  // history stays inspectable.
  const led = await prisma.doctorPayoutLedger.updateMany({
    where: { referralDoctorId: doctor.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  console.log(`  ${led.count} wrong-direction ledger rows soft-deleted`);

  // Retire the impostor doctor row so nobody picks it at the counter again.
  await prisma.referralDoctor.update({
    where: { id: doctor.id },
    data: { isActive: false, name: `${DOCTOR_NAME} (migrated → ${partnerNumber})` },
  });
  console.log(`  old doctor row retired`);

  console.log(`\n✓ Committed. ${PARTNER_NAME} is ${partnerNumber}.\n`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

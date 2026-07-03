/**
 * create-xray-billonly.ts — Create a BILL_ONLY variant of each X-ray product.
 *
 * For every source code below, clone the existing BillableProduct into a new
 * BILL_ONLY product whose code is `<sourceCode>BILL`. Name, price, payout
 * category, display order and active state are copied verbatim from the source
 * row (source of truth = DB, not the pasted list). Idempotent: skips a BILL
 * variant that already exists, and reports any source code missing from the DB.
 *
 *   npx ts-node prisma/create-xray-billonly.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The 28 X-ray products to mirror as bill-only items.
const SOURCE_CODES = [
  'XRAYDLSAPLAT',
  'XRAYRAAL',
  'XRAYREAL',
  'XRAYFOREARM',
  'XRAYBKA',
  'XRAYBKAL',
  'XRAYBKL',
  'XRAYCSAP',
  'XRAYCSAL',
  'XRAYCA',
  'XRAYCP',
  'XRAYDO',
  'XRAYHSG',
  'XRAYIVP',
  'XRAYLEAL',
  'XRAYFOOT',
  'XRAYLSAL',
  'XRAYLSFE',
  'XRAYLSL',
  'XRAYPNS',
  'XRAYRGU',
  'XRAYRHAL',
  'XRAYRKA',
  'XRAYRKL',
  'XRAYSHOAPLAT',
  'XRAY',
  'XRAYCPA',
  'XRAYRKNEEAL',
];

async function main() {
  const created: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const code of SOURCE_CODES) {
    const src = await prisma.billableProduct.findUnique({ where: { code } });
    if (!src) {
      missing.push(code);
      continue;
    }

    const billCode = `${code}BILL`;
    const already = await prisma.billableProduct.findUnique({ where: { code: billCode } });
    if (already) {
      skipped.push(billCode);
      continue;
    }

    await prisma.billableProduct.create({
      data: {
        name: src.name,
        code: billCode,
        description: src.description,
        basePriceInPaise: src.basePriceInPaise,
        isBundle: false,
        workflowMode: 'BILL_ONLY',
        payoutCategory: src.payoutCategory,
        displayOrder: src.displayOrder,
        isActive: src.isActive,
      },
    });
    created.push(billCode);
  }

  console.log(`\nCreated ${created.length} bill-only products:`);
  created.forEach((c) => console.log(`  + ${c}`));
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} (already exist):`);
    skipped.forEach((c) => console.log(`  = ${c}`));
  }
  if (missing.length) {
    console.log(`\nMissing ${missing.length} source codes (no product found — not created):`);
    missing.forEach((c) => console.log(`  ! ${c}`));
  }
}

main()
  .catch((e) => {
    console.error('Failed:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * create-billonly.ts — Create a BILL_ONLY variant of each given product.
 *
 * For every source code passed as a CLI arg, clone the existing BillableProduct
 * into a new BILL_ONLY product whose code is `<sourceCode>BILL`. Name, price,
 * payout category, display order and active state are copied verbatim from the
 * source row (source of truth = DB). Idempotent: skips a BILL variant that
 * already exists, and reports any source code missing from the DB.
 *
 *   npx ts-node prisma/create-billonly.ts USGAB USGAN USG ...
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SOURCE_CODES = process.argv.slice(2);

async function main() {
  if (SOURCE_CODES.length === 0) {
    console.error('No source codes given. Usage: npx ts-node prisma/create-billonly.ts CODE1 CODE2 ...');
    process.exit(1);
  }

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

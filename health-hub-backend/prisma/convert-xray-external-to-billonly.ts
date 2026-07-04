/**
 * convert-xray-external-to-billonly.ts — Flip specific X-ray products from
 * EXTERNAL_UPLOAD to BILL_ONLY.
 *
 * These `<code>BILL` X-ray products were showing as "External Upload" in the
 * catalog but never actually carry a PDF (films only, 0 files). They should be
 * BILL_ONLY: billed, no report, off the result-entry worklist. This only
 * changes the product *definition* — existing TestOrders keep their snapshotted
 * workflowMode, so past visits are untouched; only future orders pick up the
 * new mode. Idempotent: skips a product already BILL_ONLY, reports any missing
 * code, and never touches a product that isn't currently EXTERNAL_UPLOAD.
 *
 *   npx ts-node prisma/convert-xray-external-to-billonly.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// The 15 X-ray bill variants to move EXTERNAL_UPLOAD → BILL_ONLY.
const CODES = [
  'XRAYIVPBILL',
  'XRAYLEALBILL',
  'XRAYFOOTBILL',
  'XRAYLSALBILL',
  'XRAYLSFEBILL',
  'XRAYLSLBILL',
  'XRAYPNSBILL',
  'XRAYRGUBILL',
  'XRAYRHALBILL',
  'XRAYRKABILL',
  'XRAYRKLBILL',
  'XRAYSHOAPLATBILL',
  'XRAYBILL',
  'XRAYCPABILL',
  'XRAYRKNEEALBILL',
];

async function main() {
  const converted: string[] = [];
  const alreadyBillOnly: string[] = [];
  const unexpectedMode: string[] = [];
  const missing: string[] = [];

  for (const code of CODES) {
    const product = await prisma.billableProduct.findUnique({ where: { code } });
    if (!product) {
      missing.push(code);
      continue;
    }
    if (product.workflowMode === 'BILL_ONLY') {
      alreadyBillOnly.push(code);
      continue;
    }
    if (product.workflowMode !== 'EXTERNAL_UPLOAD') {
      // Don't silently reclassify a REPORTABLE product — surface it instead.
      unexpectedMode.push(`${code} (${product.workflowMode})`);
      continue;
    }

    await prisma.billableProduct.update({
      where: { id: product.id },
      data: { workflowMode: 'BILL_ONLY' },
    });
    converted.push(code);
  }

  console.log(`\nConverted ${converted.length} products EXTERNAL_UPLOAD → BILL_ONLY:`);
  converted.forEach((c) => console.log(`  → ${c}`));
  if (alreadyBillOnly.length) {
    console.log(`\nAlready BILL_ONLY ${alreadyBillOnly.length} (skipped):`);
    alreadyBillOnly.forEach((c) => console.log(`  = ${c}`));
  }
  if (unexpectedMode.length) {
    console.log(`\nUnexpected mode ${unexpectedMode.length} (NOT changed — review):`);
    unexpectedMode.forEach((c) => console.log(`  ! ${c}`));
  }
  if (missing.length) {
    console.log(`\nMissing ${missing.length} codes (no product found):`);
    missing.forEach((c) => console.log(`  ? ${c}`));
  }
}

main()
  .catch((e) => {
    console.error('Failed:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * convert-imaging-pending-billonly.ts
 *
 * Money-neutral cleanup: reclassify imaging orders stuck in the "pending"
 * worklist as BILL_ONLY. Classifies by the order's SNAPSHOT NAME and, as a
 * fallback, by its PRODUCT name/code — so it also catches mis-snapshotted orders
 * (e.g. an order snapshotted as "WIDAL" but billed under product "X-RAY CHEST
 * PA"). Blood tests whose product is also a lab test are never matched.
 *
 * Includes orders on visits whose report is already FINALIZED: converting the
 * order's workflowMode and completing the visit does NOT touch the finalized
 * report snapshot/PDF — it only clears the still-pending imaging line.
 *
 * Categories (pick with --cats, default: XRAY,USG,CT,ECG,ECHO):
 *   XRAY  USG (incl ultrasound/doppler)  CT  ECG  ECHO (2D-echo)
 *
 *   npx ts-node prisma/convert-imaging-pending-billonly.ts            # dry run
 *   npx ts-node prisma/convert-imaging-pending-billonly.ts --apply
 *   npx ts-node prisma/convert-imaging-pending-billonly.ts --apply --cats XRAY,USG,CT
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const catArg = process.argv[process.argv.indexOf('--cats') + 1];
const CATS = new Set(
  (process.argv.includes('--cats') && catArg ? catArg : 'XRAY,USG,CT,ECG,ECHO')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
);

const INCLUSION = ['REPORTABLE', 'EXTERNAL_UPLOAD'];
const PENDING = ['DRAFT', 'WAITING', 'IN_PROGRESS'];

/** Imaging category for a string, else null. Word-boundaried to avoid matching
 *  e.g. "C-REACTIVE" (has "CT" inside "reaCTive"). */
function classifyStr(s: string): string | null {
  const n = (s || '').toUpperCase();
  if (/X\s*-?\s*RAY/.test(n)) return 'XRAY';
  if (/\bUSG\b|ULTRASOUND|DOO?PPLER/.test(n)) return 'USG';
  if (/\bC\.?T\b/.test(n)) return 'CT';
  if (/\bECG\b|ELECTROCARDIOGRAM/.test(n)) return 'ECG';
  if (/2\s*-?\s*D[\s-]*ECHO|ECHOCARDIOGRAM/.test(n)) return 'ECHO';
  return null;
}

/** Classify an order by its own name first, then fall back to its product. */
function classifyOrder(o: any): string | null {
  return classifyStr(o.testNameSnapshot || '')
    || classifyStr(o.product?.name || '')
    || classifyStr(o.product?.code || '');
}

async function main() {
  const candidates = await prisma.testOrder.findMany({
    where: {
      cancelledAt: null,
      workflowMode: { in: INCLUSION as any },
      visit: { status: { in: PENDING as any } },
    },
    include: { product: true, visit: { include: { testOrders: true } } },
  });

  const tagged = candidates
    .map((o) => ({ o, cat: classifyOrder(o) }))
    .filter((x) => x.cat && CATS.has(x.cat));

  const orders = tagged.map((x) => x.o);
  const targetOrderIds = new Set(orders.map((o) => o.id));

  const byName = new Map<string, number>();
  for (const { o, cat } of tagged) {
    const k = `${cat}  ${o.testNameSnapshot}${o.testNameSnapshot !== o.product?.name ? `  (product: ${o.product?.name})` : ''}`;
    byName.set(k, (byName.get(k) ?? 0) + 1);
  }

  const visitsById = new Map<string, any>();
  for (const o of orders) visitsById.set(o.visit.id, o.visit);
  const visitsToComplete: string[] = [];
  let visitsStaying = 0;
  for (const [vid, v] of visitsById) {
    const remaining = v.testOrders.filter(
      (t: any) => !t.cancelledAt && INCLUSION.includes(t.workflowMode) && !targetOrderIds.has(t.id),
    );
    if (remaining.length === 0) visitsToComplete.push(vid);
    else visitsStaying++;
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — imaging pending → BILL_ONLY   cats=[${[...CATS].join(',')}]\n`);
  console.log(`Orders to convert:  ${orders.length}`);
  console.log(`Visits affected:    ${visitsById.size}  (→ COMPLETED ${visitsToComplete.length}, stay pending ${visitsStaying})`);
  console.log(`\nConverting, by test:`);
  for (const [name, n] of [...byName.entries()].sort()) console.log(`  ${String(n).padStart(3)}  ${name}`);

  if (!APPLY) {
    console.log(`\nDry run only. Re-run with --apply to write.`);
    return;
  }

  const r1 = await prisma.testOrder.updateMany({
    where: { id: { in: [...targetOrderIds] } },
    data: { workflowMode: 'BILL_ONLY' },
  });
  let r2 = { count: 0 };
  if (visitsToComplete.length) {
    r2 = await prisma.visit.updateMany({
      where: { id: { in: visitsToComplete }, status: { in: PENDING as any } },
      data: { status: 'COMPLETED' },
    });
  }
  console.log(`\nDone. Orders converted: ${r1.count}. Visits marked COMPLETED: ${r2.count}.`);
}

main()
  .catch((e) => {
    console.error('Failed:', e.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

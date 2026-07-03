/**
 * convert-radiology-pending-billonly.ts
 *
 * Cleanup for radiology orders that were mistakenly created as REPORTABLE /
 * EXTERNAL_UPLOAD and are now stuck in the "pending" worklist, when they should
 * be BILL_ONLY (billed, no report / no upload expected).
 *
 * What it does (money-neutral — never touches prices, bills or payments):
 *   1. Finds non-cancelled TestOrders whose workflowMode is REPORTABLE or
 *      EXTERNAL_UPLOAD, whose testCodeSnapshot starts with XRAY / USG / CT, on a
 *      visit still in a pending state (DRAFT | WAITING | IN_PROGRESS), excluding
 *      any visit that already has a FINALIZED report version.
 *   2. Sets those orders' workflowMode = BILL_ONLY (drops them from the report /
 *      upload worklist — see getReportInclusionOrders).
 *   3. For each affected visit, if NO report-inclusion order remains (i.e. every
 *      remaining non-cancelled order is now BILL_ONLY), flips Visit.status to
 *      COMPLETED — matching how a pure bill-only visit is created.
 *
 * Dry-run by default. Pass --apply to write.
 *
 *   npx ts-node prisma/convert-radiology-pending-billonly.ts          # preview
 *   npx ts-node prisma/convert-radiology-pending-billonly.ts --apply  # execute
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const PREFIXES = ['XRAY', 'USG', 'CT'];
const INCLUSION = ['REPORTABLE', 'EXTERNAL_UPLOAD'];
const PENDING = ['DRAFT', 'WAITING', 'IN_PROGRESS'];

function isFinalized(visit: any): boolean {
  return !!visit.report?.versions?.some((v: any) => v.status === 'FINALIZED');
}

async function main() {
  const candidates = await prisma.testOrder.findMany({
    where: {
      cancelledAt: null,
      workflowMode: { in: INCLUSION as any },
      OR: PREFIXES.map((p) => ({ testCodeSnapshot: { startsWith: p } })),
      visit: { status: { in: PENDING as any } },
    },
    include: {
      visit: { include: { testOrders: true, report: { include: { versions: true } } } },
    },
  });

  // Drop orders on visits with a finalized report (do not disturb finalized work).
  const orders = candidates.filter((o) => !isFinalized(o.visit));

  const targetOrderIds = new Set(orders.map((o) => o.id));

  // Breakdown by test code.
  const byCode = new Map<string, number>();
  for (const o of orders) {
    const k = o.testCodeSnapshot || '(no code)';
    byCode.set(k, (byCode.get(k) ?? 0) + 1);
  }

  // Which visits become fully bill-only (→ COMPLETED) vs still have a real
  // report-inclusion order remaining (stay pending).
  const visitsById = new Map<string, any>();
  for (const o of orders) visitsById.set(o.visit.id, o.visit);

  const visitsToComplete: string[] = [];
  const visitsStayingPending: string[] = [];
  for (const [vid, v] of visitsById) {
    const remaining = v.testOrders.filter(
      (t: any) => !t.cancelledAt && INCLUSION.includes(t.workflowMode) && !targetOrderIds.has(t.id),
    );
    if (remaining.length === 0) visitsToComplete.push(vid);
    else visitsStayingPending.push(vid);
  }

  const skippedFinalized = candidates.length - orders.length;

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — radiology pending → BILL_ONLY\n`);
  console.log(`Orders to convert:      ${orders.length}`);
  console.log(`Visits affected:        ${visitsById.size}`);
  console.log(`  → become COMPLETED:   ${visitsToComplete.length} (no report-inclusion order left)`);
  console.log(`  → stay pending:       ${visitsStayingPending.length} (still have a non-radiology reportable order)`);
  if (skippedFinalized > 0) console.log(`Skipped (finalized report): ${skippedFinalized} orders`);
  console.log(`\nBy test code:`);
  for (const [code, n] of [...byCode.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${code}`);
  }

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

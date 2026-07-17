/**
 * Backfill: complete the diagnostic visits stranded in DRAFT by the films-only
 * ("no report needed") close bug.
 *
 * Before the reevaluateVisitCompletion fix, closing the LAST reportable/external
 * order as "no report needed" flipped only TestOrder.noReportAt and never
 * re-derived the visit — so the visit sat in DRAFT forever, invisible in both
 * Pending (nothing left to enter) and Finalized (not COMPLETED). This sweeps the
 * whole stranded class and completes each one, mirroring reevaluateVisitCompletion:
 *   - status DRAFT/WAITING -> COMPLETED
 *   - FINALIZE / Visit audit (autoCompleted + backfill trace)
 *   - deliberately NO WhatsApp (a films-only visit issues no patient report)
 *
 * PAYOUTS: a pure films-only visit (all orders REPORTABLE/EXTERNAL closed as
 * no-report, no BILL_ONLY order, no finalized report) falls entirely OUTSIDE
 * buildDiagnosticPayoutVisitWindow (Branch A needs a finalized report; Branch B
 * needs a BILL_ONLY order), so completing it changes no commission and we do NOT
 * call derivePayout for it (that would only churn TODAY's ledgers for 79 doctors
 * for zero benefit). BUT a visit that also carries a BILL_ONLY order DOES enter
 * Branch B once COMPLETED, so for those — and only those — we re-derive referral +
 * diagnostic-centre payouts (for the completion-day period, matching the runtime
 * helper), otherwise that bill-only commission would go uncredited. As of
 * 2026-07-18 the class has 0 such visits, so this branch is defensive; it makes
 * the script structurally correct if a mixed bill-only + films-only visit ever
 * strands. An outstanding bill due is NOT touched — it stays on the bill, still
 * collectible; completing merely makes the visit visible so it can be chased.
 * Due visits are flagged below for review.
 *
 * The candidate query is DYNAMIC (not a hard-coded id list) and every visit is
 * RE-FETCHED and RE-VERIFIED right before the write, so the script is idempotent
 * and safe against concurrent staff activity and the already-deployed runtime fix
 * (a visit the fix already completed no longer qualifies and is skipped).
 *
 * DRY-RUN by default. Pass --commit to write. Run AFTER the code fix deploys so
 * the backlog is stable and the logic matches runtime.
 */
import prisma from '../src/lib/prisma';
import { DiagnosticWorkflowMode } from '@prisma/client';
import { logAction } from '../src/services/auditService';
import { computeBillFinancialsFromPersisted } from '../src/services/billFinancialService';
import { derivePayout } from '../src/services/payoutService';

const COMMIT = process.argv.includes('--commit');

// Mirror of getReportInclusionOrders (REPORTABLE or EXTERNAL_UPLOAD, not
// cancelled, not waived) — orders that still owe a patient-facing report.
function reportInclusion<
  T extends { workflowMode?: any; cancelledAt?: any; noReportAt?: any },
>(orders: T[]): T[] {
  return orders.filter(
    (o) =>
      !o.cancelledAt &&
      !o.noReportAt &&
      ((o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
        o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
  );
}

async function main() {
  console.log(
    `Mode: ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}\n`,
  );

  // Candidate = DRAFT diagnostic visit with at least one resolved (no-report or
  // cancelled) order. The full guard (0 report-inclusion remaining) is applied in
  // memory below and again per-visit before the write.
  const candidates = await prisma.visit.findMany({
    where: {
      domain: 'DIAGNOSTICS',
      // Both DRAFT and WAITING strand the same way (WAITING arises after a
      // release-partial), and reevaluateVisitCompletion accepts both — so the
      // candidate query must too, or WAITING stranded visits are silently missed.
      status: { in: ['DRAFT', 'WAITING'] },
      testOrders: {
        some: {
          OR: [{ noReportAt: { not: null } }, { cancelledAt: { not: null } }],
        },
      },
    },
    select: {
      id: true,
      billNumber: true,
      branchId: true,
      branch: { select: { name: true } },
      createdAt: true,
      testOrders: {
        select: {
          id: true,
          testNameSnapshot: true,
          workflowMode: true,
          noReportAt: true,
          cancelledAt: true,
        },
      },
      bill: {
        select: {
          totalAmountInPaise: true,
          discountAmountInPaise: true,
          couponDiscountInPaise: true,
          reversedChargeInPaise: true,
          paidAmountInPaise: true,
          refundedAmountInPaise: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const toComplete = candidates.filter(
    (v) => reportInclusion(v.testOrders).length === 0,
  );
  const skipped = candidates.length - toComplete.length;

  console.log(`Candidates (DRAFT + a resolved order): ${candidates.length}`);
  console.log(`Qualify (0 report-inclusion remaining): ${toComplete.length}`);
  console.log(`Skip (still has reportable work): ${skipped}\n`);

  let dueCount = 0;
  for (const v of toComplete) {
    const due = v.bill
      ? computeBillFinancialsFromPersisted(v.bill).dueAmountInPaise
      : 0;
    if (due > 0) dueCount++;
    const resolved = v.testOrders.filter((o) => o.noReportAt || o.cancelledAt);
    console.log(
      `→ ${v.billNumber} (${v.branch?.name ?? '?'}) ` +
        `${v.createdAt.toISOString().slice(0, 10)}: complete ` +
        `(${resolved.length}/${v.testOrders.length} orders resolved` +
        `${due > 0 ? `, DUE ₹${(due / 100).toFixed(2)} — kept on bill` : ''})`,
    );
  }
  console.log(
    `\n${toComplete.length} to complete` +
      `${dueCount ? `, of which ${dueCount} carry an outstanding due (NOT waived)` : ''}.`,
  );

  if (!COMMIT) {
    console.log('\nDRY-RUN — no writes. Re-run with --commit to apply.');
    return;
  }

  let done = 0;
  for (const cand of toComplete) {
    // Re-fetch live per visit for idempotency + concurrency safety.
    const visit = await prisma.visit.findUnique({
      where: { id: cand.id },
      select: {
        id: true,
        billNumber: true,
        status: true,
        branchId: true,
        testOrders: {
          select: {
            id: true,
            workflowMode: true,
            noReportAt: true,
            cancelledAt: true,
          },
        },
        referrals: {
          where: { deletedAt: null },
          select: { referralDoctorId: true },
        },
        diagnosticCenterReferrals: {
          select: { diagnosticCenterId: true },
        },
      },
    });
    if (!visit) {
      console.log(`✗ ${cand.billNumber}: gone — skip`);
      continue;
    }
    if (visit.status !== 'DRAFT' && visit.status !== 'WAITING') {
      console.log(`• ${cand.billNumber}: status ${visit.status} — skip`);
      continue;
    }
    if (reportInclusion(visit.testOrders).length > 0) {
      console.log(`• ${cand.billNumber}: reportable work remains — skip`);
      continue;
    }
    if (!visit.testOrders.some((o) => o.noReportAt || o.cancelledAt)) {
      console.log(`• ${cand.billNumber}: no resolved order — skip`);
      continue;
    }

    const completedAt = new Date();
    // Race-safe flip: only if still open (updateMany matches 0 rows if the
    // runtime fix or a concurrent action already completed it).
    const flipped = await prisma.visit.updateMany({
      where: { id: visit.id, status: { in: ['DRAFT', 'WAITING'] } },
      data: { status: 'COMPLETED' },
    });
    if (flipped.count !== 1) {
      console.log(`• ${cand.billNumber}: raced — skip`);
      continue;
    }

    await logAction({
      branchId: visit.branchId,
      actionType: 'FINALIZE',
      entityType: 'Visit',
      entityId: visit.id,
      userId: null,
      newValues: {
        status: 'COMPLETED',
        noReport: true,
        autoCompleted: true,
        via: 'finalize-stranded-noreport-visits backfill',
        completedAt: completedAt.toISOString(),
        resolvedOrderIds: visit.testOrders
          .filter((o) => o.noReportAt || o.cancelledAt)
          .map((o) => o.id),
      },
    });

    // Payouts: only a visit that ALSO carries a BILL_ONLY order enters Branch B
    // of buildDiagnosticPayoutVisitWindow once COMPLETED — so only those need a
    // re-derive (else the bill-only commission goes uncredited). Pure films-only
    // visits change no commission, so we skip them to avoid churning today's
    // ledgers. Period = completion day (updatedAt is now → matches Branch B).
    const hasBillOnly = visit.testOrders.some(
      (o) => o.workflowMode === DiagnosticWorkflowMode.BILL_ONLY,
    );
    if (hasBillOnly) {
      const periodStartDate = new Date(completedAt);
      periodStartDate.setHours(0, 0, 0, 0);
      const periodEndDate = new Date(completedAt);
      periodEndDate.setHours(23, 59, 59, 999);
      const payoutTasks: Array<Promise<unknown>> = [];
      const refDoc = visit.referrals[0]?.referralDoctorId;
      const dc = visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;
      if (refDoc)
        payoutTasks.push(
          derivePayout('REFERRAL', refDoc, visit.branchId, periodStartDate, periodEndDate),
        );
      if (dc)
        payoutTasks.push(
          derivePayout('DIAGNOSTIC_CENTER', dc, visit.branchId, periodStartDate, periodEndDate),
        );
      if (payoutTasks.length) {
        for (const r of await Promise.allSettled(payoutTasks)) {
          if (r.status === 'rejected')
            console.error(`  payout refresh failed for ${cand.billNumber}:`, r.reason);
        }
        console.log(`  ↳ ${cand.billNumber} has a BILL_ONLY order — re-derived payouts`);
      }
    }

    done++;
    console.log(`  ✓ ${cand.billNumber} → COMPLETED`);
  }
  console.log(`\nDone: ${done} visit(s) completed.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

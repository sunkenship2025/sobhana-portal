/**
 * One-off ops script: clear the Sobhana Chintal "Result Queue" (pending
 * diagnostic visits) by, per visit:
 *   1. closing every ACTIVE reportable/external order that has NO result entered
 *      as "no report needed" (films-only) — the stragglers (a culture never
 *      resulted, an external X-ray never uploaded), and
 *   2. FINALIZING the report with whatever results ARE entered — SILENTLY
 *      (no "report ready" WhatsApp), or, if nothing was ever entered, completing
 *      the visit as a pure no-report.
 *
 * This mirrors the app exactly: no-report = POST /:id/orders/:orderId/no-report,
 * finalize = POST /:id/finalize (minus the sendReportReady + minus the
 * INCOMPLETE_REPORT/BILL_DUE guards, which no longer apply once the un-entered
 * orders are waived). "Ready" is judged with the SAME hasMeaningfulResultRow +
 * external-upload logic the worklist uses, so classification matches the UI.
 *
 * SCOPE: all Chintal DRAFT/WAITING diagnostic visits EXCEPT the two the operator
 * is keeping (D-CNT-000778 CHASHMINI, D-CNT-000762 K.SWAMY). All 30 targets are
 * ₹0 due. No bill is ever changed; a due (if any) would stay on the bill.
 *
 * Re-fetches nothing extra — but the finalize flip is race-safe (updateMany
 * guarded on DRAFT) and no-report is idempotent (skips orders already waived).
 *
 * DRY-RUN by default (reads only). Pass --commit to write. --limit=N for a canary.
 *   npx ts-node --transpile-only prisma/finalize-chintal-queue.ts            # dry-run
 *   npx ts-node --transpile-only prisma/finalize-chintal-queue.ts --commit
 *   npx ts-node --transpile-only prisma/finalize-chintal-queue.ts --commit --limit=1
 *
 * DATABASE_URL in .env points at PRODUCTION — treat --commit as a prod write.
 */
import prisma from '../src/lib/prisma';
import { DiagnosticWorkflowMode } from '@prisma/client';

const COMMIT = process.argv.includes('--commit');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// The two the operator is KEEPING (fresh / has an open balance).
const EXCLUDE_BILLS = ['D-CNT-000778', 'D-CNT-000762'];

const NO_REPORT_REASON = 'Backlog cleanup — no result entered (queue clear)';

// Mirror of hasMeaningfulResultRow (routes/diagnosticVisits.ts).
const DERIVED_MANUAL_OVERRIDE_NOTE = '__DERIVED_MANUAL_OVERRIDE__';
const DERIVED_AUTO_NOTE_PREFIX = 'Auto-calculated: ';
function hasMeaningfulResultRow(r: {
  value?: number | null;
  textValue?: string | null;
  notes?: string | null;
}): boolean {
  if (r.value !== null && r.value !== undefined) return true;
  if (typeof r.textValue === 'string' && r.textValue.trim()) return true;
  const notes = r.notes?.trim();
  if (!notes) return false;
  return notes !== DERIVED_MANUAL_OVERRIDE_NOTE && !notes.startsWith(DERIVED_AUTO_NOTE_PREFIX);
}

const isReportInclusion = (o: { workflowMode: DiagnosticWorkflowMode; cancelledAt: Date | null; noReportAt: Date | null }) =>
  !o.cancelledAt &&
  !o.noReportAt &&
  ((o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE ||
    o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD);

async function main() {
  const branch = await prisma.branch.findFirst({
    where: { name: { contains: 'Chintal', mode: 'insensitive' as const } },
    select: { id: true, name: true, code: true },
  });
  if (!branch) throw new Error('Chintal branch not found');

  const visits = await prisma.visit.findMany({
    where: {
      branchId: branch.id,
      domain: 'DIAGNOSTICS',
      status: { in: ['DRAFT', 'WAITING'] },
      billNumber: { notIn: EXCLUDE_BILLS },
    },
    select: {
      id: true,
      billNumber: true,
      status: true,
      createdAt: true,
      patient: { select: { name: true } },
      referrals: { where: { deletedAt: null }, select: { referralDoctorId: true } },
      diagnosticCenterReferrals: { select: { diagnosticCenterId: true } },
      testOrders: {
        select: {
          id: true,
          testNameSnapshot: true,
          workflowMode: true,
          cancelledAt: true,
          noReportAt: true,
          uploadInsteadAt: true,
          externalUploads: { where: { deletedAt: null }, select: { id: true }, take: 1 },
        },
      },
      report: {
        select: {
          id: true,
          versions: {
            where: { status: 'DRAFT' },
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: {
              id: true,
              versionNum: true,
              testResults: { select: { testOrderId: true, value: true, textValue: true, notes: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Classify each visit.
  const plans = visits.map((v) => {
    const draft = v.report?.versions[0] ?? null;
    const meaningfulOrderIds = new Set(
      (draft?.testResults ?? []).filter(hasMeaningfulResultRow).map((r) => r.testOrderId),
    );
    const active = v.testOrders.filter(isReportInclusion);
    const entered = active.filter((o) =>
      o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD
        ? o.externalUploads.length > 0
        : meaningfulOrderIds.has(o.id),
    );
    // Un-entered orders get waived — but never touch an "upload instead" order
    // (it's mid-flip to an external PDF; waiving it would be contradictory).
    const toNoReport = active.filter(
      (o) => !entered.some((e) => e.id === o.id) && !o.uploadInsteadAt,
    );
    const uploadInsteadOpen = active.filter(
      (o) => !entered.some((e) => e.id === o.id) && o.uploadInsteadAt,
    );
    const willFinalize = !!draft && meaningfulOrderIds.size > 0;
    return { v, draft, active, entered, toNoReport, uploadInsteadOpen, willFinalize };
  });

  console.log('====================================================================');
  console.log(`Branch : ${branch.name} (${branch.code})`);
  console.log(`Mode   : ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}  |  silent (no WhatsApp)`);
  console.log(`Keeping: ${EXCLUDE_BILLS.join(', ')}`);
  console.log(`Targets: ${plans.length} pending visit(s)`);
  console.log('--------------------------------------------------------------------');
  for (const p of plans) {
    const action = p.willFinalize
      ? `FINALIZE v${p.draft!.versionNum} (${p.entered.length} entered)`
      : 'COMPLETE as no-report (nothing entered)';
    const waive =
      p.toNoReport.length > 0
        ? `  | no-report ${p.toNoReport.length}: ${p.toNoReport.map((o) => o.testNameSnapshot).join(', ')}`
        : '';
    const uw = p.uploadInsteadOpen.length ? `  | ⚠ ${p.uploadInsteadOpen.length} upload-instead LEFT OPEN` : '';
    console.log(
      `  ${(p.v.billNumber ?? '?').padEnd(14)} ${(p.v.patient?.name ?? '?').padEnd(22)} ${p.v.status.padEnd(8)} ${p.active.length} active -> ${action}${waive}${uw}`,
    );
  }
  console.log('--------------------------------------------------------------------');
  const totalWaive = plans.reduce((s, p) => s + p.toNoReport.length, 0);
  const finalizeCount = plans.filter((p) => p.willFinalize).length;
  const completeCount = plans.length - finalizeCount;
  const uploadOpen = plans.reduce((s, p) => s + p.uploadInsteadOpen.length, 0);
  console.log(
    `Summary: ${plans.length} visits | ${finalizeCount} finalize + ${completeCount} complete-no-report | ${totalWaive} orders waived${uploadOpen ? ` | ${uploadOpen} upload-instead left open` : ''}`,
  );

  if (!COMMIT) {
    console.log('\nDRY-RUN only. Re-run with --commit to apply (silent).');
    return;
  }

  const { createReportSnapshot, saveReportSnapshot } = await import('../src/services/reportSnapshotService');
  const { createAccessToken } = await import('../src/services/reportAccessService');
  const { derivePayout } = await import('../src/services/payoutService');
  const { logAction } = await import('../src/services/auditService');

  const toProcess = plans.slice(0, LIMIT);
  if (Number.isFinite(LIMIT)) console.log(`(canary/limit: processing only the first ${LIMIT})`);
  let ok = 0;
  let failed = 0;
  const failures: Array<{ bill: string; err: string }> = [];

  for (const p of toProcess) {
    const v = p.v;
    const label = v.billNumber ?? v.id;
    try {
      const now = new Date();

      // 1. Waive the un-entered stragglers (idempotent: skip already-waived).
      for (const o of p.toNoReport) {
        await prisma.testOrder.update({
          where: { id: o.id },
          data: {
            noReportAt: now,
            noReportReason: NO_REPORT_REASON,
            noReportByUserId: null,
            reopenedAt: null,
            reopenedByUserId: null,
          },
        });
        await logAction({
          branchId: branch.id,
          actionType: 'UPDATE',
          entityType: 'TestOrder',
          entityId: o.id,
          userId: null,
          newValues: {
            noReport: true,
            reason: NO_REPORT_REASON,
            testName: o.testNameSnapshot,
            via: 'finalize-chintal-queue script',
            closedAt: now.toISOString(),
          },
        });
      }

      // 2a. Finalize the entered results (if any), else 2b complete as no-report.
      const finalizedAt = new Date();
      if (p.willFinalize && p.draft) {
        await prisma.$transaction(async (tx) => {
          const updated = await tx.reportVersion.updateMany({
            where: { id: p.draft!.id, status: 'DRAFT' },
            data: { status: 'FINALIZED', finalizedAt },
          });
          if (updated.count === 0) throw new Error('ALREADY_FINALIZED (raced)');
          await tx.visit.update({ where: { id: v.id }, data: { status: 'COMPLETED' } });
        });

        try {
          const snapshot = await createReportSnapshot(p.draft.id);
          await saveReportSnapshot(p.draft.id, snapshot);
          await createAccessToken(p.draft.id);
        } catch (snapErr: any) {
          console.error(`    [snapshot] ${label}: ${snapErr?.message ?? snapErr}`);
        }

        await logAction({
          branchId: branch.id,
          actionType: 'FINALIZE',
          entityType: 'Report',
          entityId: p.draft.id,
          userId: null,
          oldValues: { status: 'DRAFT' },
          newValues: {
            status: 'FINALIZED',
            reportVersionId: p.draft.id,
            visitId: v.id,
            finalizedAt: finalizedAt.toISOString(),
            waivedOrderIds: p.toNoReport.map((o) => o.id),
            via: 'finalize-chintal-queue script',
            silent: true,
          },
        });
      } else {
        // Nothing entered — every order is now waived; complete as no-report.
        const flipped = await prisma.visit.updateMany({
          where: { id: v.id, status: { in: ['DRAFT', 'WAITING'] } },
          data: { status: 'COMPLETED' },
        });
        if (flipped.count === 0) throw new Error('VISIT_NOT_OPEN (raced)');
        await logAction({
          branchId: branch.id,
          actionType: 'FINALIZE',
          entityType: 'Visit',
          entityId: v.id,
          userId: null,
          newValues: {
            status: 'COMPLETED',
            noReport: true,
            waivedOrderIds: p.toNoReport.map((o) => o.id),
            via: 'finalize-chintal-queue script',
            silent: true,
            completedAt: finalizedAt.toISOString(),
          },
        });
      }

      // 3. Payout derivation (referral / diagnostic-center) — mirrors the app.
      const periodStart = new Date(finalizedAt);
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(finalizedAt);
      periodEnd.setHours(23, 59, 59, 999);
      const refId = v.referrals[0]?.referralDoctorId;
      const dcId = v.diagnosticCenterReferrals[0]?.diagnosticCenterId;
      const tasks: Array<Promise<unknown>> = [];
      if (refId) tasks.push(derivePayout('REFERRAL', refId, branch.id, periodStart, periodEnd));
      if (dcId) tasks.push(derivePayout('DIAGNOSTIC_CENTER', dcId, branch.id, periodStart, periodEnd));
      if (tasks.length) {
        for (const r of await Promise.allSettled(tasks)) {
          if (r.status === 'rejected') console.error(`    [payout] ${label}: ${r.reason}`);
        }
      }

      ok++;
      console.log(
        `  ✓ ${label} ${p.willFinalize ? 'finalized' : 'completed (no-report)'}${p.toNoReport.length ? ` (waived ${p.toNoReport.length})` : ''} (silent)`,
      );
    } catch (err: any) {
      failed++;
      failures.push({ bill: label, err: err?.message ?? String(err) });
      console.error(`  ✗ ${label}: ${err?.message ?? err}`);
    }
  }

  console.log('--------------------------------------------------------------------');
  console.log(`Done. Processed ${ok}, failed ${failed}, total ${toProcess.length}.`);
  if (failures.length) failures.forEach((f) => console.log(`  ${f.bill}: ${f.err}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Reverse the mistaken "no report needed" (films-only) closes that Pranav did on
 * these 4 FINALIZED visits. Mirrors POST /:id/orders/:orderId/reopen-report exactly:
 *   - clear noReportAt/noReportReason/noReportByUserId, set reopenedAt
 *   - if visit was COMPLETED and reopening restores a report-inclusion order -> visit back to DRAFT
 *   - if no open draft (all finalized) -> open next DRAFT version carrying forward last finalized results
 *   - audit log (UPDATE TestOrder, reopened:true)
 *
 * Re-fetches live state per order and SKIPS any order whose noReportAt is already
 * null (idempotent + safe against concurrent staff activity).
 *
 * DRY-RUN by default. Pass --commit to write.
 */
import prisma from '../src/lib/prisma';
import { DiagnosticWorkflowMode } from '@prisma/client';
import { logAction } from '../src/services/auditService';

const COMMIT = process.argv.includes('--commit');

const TARGETS = [
  { bill: 'D-CNT-000379', visitId: 'cmr8vh706054z6scltvp7fto6', orderId: 'cmr8vh70u056d6scl3k854303', test: 'ECG' },
  { bill: 'D-CNT-000588', visitId: 'cmrhigj54021o73ymvopve6om', orderId: 'cmrhigj5s022873ymvpa0iuc6', test: 'URINE C&S' },
  { bill: 'D-BLN-000517', visitId: 'cmr3l2v8t04yex4sv5jaaoyld', orderId: 'cmr3l2v9t04z0x4svcw6sckiq', test: 'THYROID PROFILE' },
  { bill: 'D-BLN-000642', visitId: 'cmrbpygyd074nsjey4t5uzfq0', orderId: 'cmrbpygzc0758sjeyo13s4nh7', test: 'USG OF ABDOMEN' },
];

// Mirror of getReportInclusionOrders (REPORTABLE or EXTERNAL_UPLOAD, not cancelled, not waived).
function reportInclusion<T extends { workflowMode?: any; cancelledAt?: any; noReportAt?: any }>(orders: T[]): T[] {
  return orders.filter(
    (o) =>
      !o.cancelledAt &&
      !o.noReportAt &&
      ((o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE ||
        o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
  );
}

async function main() {
  console.log(`Mode: ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}\n`);

  for (const t of TARGETS) {
    const visit = await prisma.visit.findUnique({
      where: { id: t.visitId },
      select: {
        id: true,
        billNumber: true,
        status: true,
        branchId: true,
        report: {
          select: {
            id: true,
            versions: { orderBy: { versionNum: 'desc' }, select: { id: true, versionNum: true, status: true } },
          },
        },
        testOrders: {
          select: { id: true, testNameSnapshot: true, workflowMode: true, noReportAt: true, cancelledAt: true },
        },
      },
    });
    if (!visit) { console.log(`✗ ${t.bill}: visit not found`); continue; }
    const order = visit.testOrders.find((o) => o.id === t.orderId);
    if (!order) { console.log(`✗ ${t.bill}: order ${t.orderId} not found`); continue; }
    if (!order.noReportAt) { console.log(`• ${t.bill} ${t.test}: already open (noReportAt null) — skip`); continue; }

    const versions = visit.report?.versions ?? [];
    const latestVersion = versions[0];
    const latestFinalized = versions.find((v) => v.status === 'FINALIZED');
    const hasOpenDraft = versions.some((v) => v.status === 'DRAFT');
    const reportId = visit.report?.id;

    const ordersAfterReopen = visit.testOrders.map((o) => (o.id === order.id ? { ...o, noReportAt: null } : o));
    const reentersEntryQueue = visit.status === 'COMPLETED' && reportInclusion(ordersAfterReopen).length > 0;
    const needsCarryForwardDraft = !hasOpenDraft && !!latestFinalized && !!reportId && !!latestVersion;

    console.log(
      `→ ${t.bill} ${t.test}: reopen order; ` +
        `${reentersEntryQueue ? 'visit COMPLETED→DRAFT; ' : ''}` +
        `${needsCarryForwardDraft ? `open v${(latestVersion!.versionNum) + 1} draft (carry forward v${latestFinalized!.versionNum})` : 'existing draft reused'}`,
    );

    if (!COMMIT) continue;

    await prisma.$transaction(async (tx) => {
      await tx.testOrder.update({
        where: { id: order.id },
        data: { noReportAt: null, noReportReason: null, noReportByUserId: null, reopenedAt: new Date(), reopenedByUserId: null },
      });
      if (reentersEntryQueue) {
        await tx.visit.update({ where: { id: visit.id }, data: { status: 'DRAFT' } });
      }
      if (needsCarryForwardDraft && reportId && latestFinalized && latestVersion) {
        const carryForward = await tx.testResult.findMany({
          where: { reportVersionId: latestFinalized.id },
          select: {
            testOrderId: true, testId: true, value: true, textValue: true, flag: true, notes: true,
            testDefinitionId: true, enteredByUserId: true, signerNameOverride: true, useSigningRule: true, selectedSigningDoctorId: true,
          },
        });
        const nextDraft = await tx.reportVersion.create({
          data: { reportId, versionNum: latestVersion.versionNum + 1, status: 'DRAFT' },
        });
        if (carryForward.length > 0) {
          await tx.testResult.createMany({ data: carryForward.map((r) => ({ ...r, reportVersionId: nextDraft.id })) });
        }
      }
    });

    await logAction({
      branchId: visit.branchId,
      actionType: 'UPDATE',
      entityType: 'TestOrder',
      entityId: order.id,
      userId: null,
      newValues: {
        noReport: false, reopened: true, testName: order.testNameSnapshot,
        via: 'reopen-mistaken-noreport script',
        ...(reentersEntryQueue ? { visitStatus: 'DRAFT' } : {}),
        ...(needsCarryForwardDraft ? { openedNextDraftVersion: (latestVersion?.versionNum ?? 0) + 1 } : {}),
      },
    });

    console.log(`  ✓ ${t.bill} ${t.test} reopened`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());

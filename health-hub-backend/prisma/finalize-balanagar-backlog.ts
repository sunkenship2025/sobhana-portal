/**
 * One-off ops script: force-finalize the backlog of DRAFT diagnostic reports in
 * the Sobhana BALANAGAR branch whose bill sequence is BEFORE a cutoff
 * (default: < 594, i.e. up to D-BLN-000593), SILENTLY (no "report ready"
 * WhatsApp / SMS to the patient).
 *
 * Mirrors POST /api/visits/diagnostic/:id/finalize EXCEPT:
 *   - skips the bill-due guard (forced)
 *   - skips sendReportReady() (silent — patients get NO message)
 *   - by default only finalizes reports that are actually COMPLETE (every
 *     non-waived reportable/external test has a result / upload). Reports with
 *     pending results are SKIPPED and listed, not locked. Pass
 *     --include-incomplete to force-finalize those too (matches the old
 *     Chintal script behaviour — use with care, it locks a report with holes).
 *   - NO-REPORT visits (films-only / bill-only: nothing to include in a report)
 *     are always skipped — they are a different completion, not a draft report.
 *
 * Per COMPLETE visit it does, exactly like the endpoint:
 *   1. reportVersion DRAFT -> FINALIZED (+ finalizedAt), visit -> COMPLETED (atomic)
 *   2. createReportSnapshot -> saveReportSnapshot -> createAccessToken (non-critical)
 *   3. audit log (FINALIZE)
 *   4. derivePayout for any referral doctor / diagnostic-center referral
 *
 * DRY-RUN by default (reads only). Pass --commit to actually write.
 *   npx ts-node --transpile-only prisma/finalize-balanagar-backlog.ts                  # dry-run
 *   npx ts-node --transpile-only prisma/finalize-balanagar-backlog.ts --commit         # execute
 *   ... --before=594            # bill-sequence cutoff (strictly less than); default 594
 *   ... --include-incomplete    # also force-finalize reports with pending results
 *   ... --limit=5               # canary: only process the first N (by bill order)
 *
 * DATABASE_URL in .env points at PRODUCTION Neon — treat --commit as a prod write.
 */
import prisma from '../src/lib/prisma';

const COMMIT = process.argv.includes('--commit');
const INCLUDE_INCOMPLETE = process.argv.includes('--include-incomplete');
const COMPLETE_NO_REPORT = process.argv.includes('--complete-no-report');
const beforeArg = process.argv.find((a) => a.startsWith('--before='));
const BEFORE_SEQ = beforeArg ? parseInt(beforeArg.split('=')[1], 10) : 594;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// Visits to never touch (e.g. deliberately reopened). None known for Balanagar yet.
const EXCLUDE_VISIT_IDS: string[] = [];

// --- inlined copies of the private finalize helpers from diagnosticVisits.ts ---
const DERIVED_MANUAL_OVERRIDE_NOTE = '__DERIVED_MANUAL_OVERRIDE__';
const DERIVED_AUTO_NOTE_PREFIX = 'Auto-calculated: ';

function hasMeaningfulResultRow(result: {
  value?: number | null;
  textValue?: string | null;
  notes?: string | null;
}): boolean {
  if (result.value !== null && result.value !== undefined) return true;
  if (typeof result.textValue === 'string' && result.textValue.trim()) return true;
  const notes = result.notes?.trim();
  if (!notes) return false;
  return notes !== DERIVED_MANUAL_OVERRIDE_NOTE && !notes.startsWith(DERIVED_AUTO_NOTE_PREFIX);
}

function getExpectedResultTestIds(order: {
  testId: string;
  test?: { isPanel?: boolean | null; childTests?: Array<{ id: string }> | null } | null;
}): string[] {
  if (order.test?.isPanel && order.test.childTests?.length) {
    return order.test.childTests.map((child) => child.id);
  }
  return [order.testId];
}

type OrderLite = {
  id: string;
  testId: string;
  testNameSnapshot: string | null;
  testCodeSnapshot: string | null;
  workflowMode: string | null;
  cancelledAt: Date | null;
  noReportAt: Date | null;
  test: { isPanel: boolean | null; childTests: { id: string }[] } | null;
  externalUploads: { id: string }[];
};

function getReportInclusionOrders(orders: OrderLite[]): OrderLite[] {
  return orders.filter(
    (o) =>
      !o.cancelledAt &&
      !o.noReportAt &&
      ((o.workflowMode ?? 'REPORTABLE') === 'REPORTABLE' ||
        o.workflowMode === 'EXTERNAL_UPLOAD'),
  );
}

function seqOf(billNumber: string | null): number {
  if (!billNumber) return NaN;
  const last = billNumber.split('-').pop() ?? '';
  return parseInt(last, 10);
}

type Klass = 'COMPLETE' | 'INCOMPLETE' | 'NO_REPORT';

async function main() {
  const branch = await prisma.branch.findFirst({
    where: { name: { contains: 'Balanagar', mode: 'insensitive' as const } },
    select: { id: true, name: true, code: true },
  });
  if (!branch) throw new Error('Balanagar branch not found (searched name ILIKE %Balanagar%)');

  const candidates = await prisma.visit.findMany({
    where: {
      branchId: branch.id,
      domain: 'DIAGNOSTICS',
      id: { notIn: EXCLUDE_VISIT_IDS },
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      report: { versions: { some: { status: 'DRAFT' } } },
    },
    select: {
      id: true,
      billNumber: true,
      createdAt: true,
      status: true,
      branchId: true,
      patient: { select: { name: true } },
      referrals: { where: { deletedAt: null }, select: { referralDoctorId: true } },
      diagnosticCenterReferrals: { select: { diagnosticCenterId: true } },
      testOrders: {
        select: {
          id: true,
          testId: true,
          testNameSnapshot: true,
          testCodeSnapshot: true,
          workflowMode: true,
          cancelledAt: true,
          noReportAt: true,
          test: { select: { isPanel: true, childTests: { select: { id: true } } } },
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
              testResults: {
                select: { testOrderId: true, testId: true, value: true, textValue: true, notes: true },
              },
            },
          },
        },
      },
    },
    orderBy: { billNumber: 'asc' },
  });

  // Scope to bill sequence < BEFORE_SEQ.
  const inScope = candidates.filter((v) => {
    const s = seqOf(v.billNumber);
    return Number.isFinite(s) && s < BEFORE_SEQ;
  });

  const classify = (v: (typeof inScope)[number]): { klass: Klass; pending: string[] } => {
    const draft = v.report?.versions[0];
    if (!draft) return { klass: 'NO_REPORT', pending: [] };
    const inclusion = getReportInclusionOrders(v.testOrders as OrderLite[]);
    if (inclusion.length === 0) return { klass: 'NO_REPORT', pending: [] };

    const meaningfulKeys = new Set(
      draft.testResults
        .filter(hasMeaningfulResultRow)
        .map((r) => `${r.testOrderId}:${r.testId}`),
    );
    const incomplete = (v.testOrders as OrderLite[]).filter((order) => {
      const mode = order.workflowMode ?? 'REPORTABLE';
      if (order.noReportAt) return false;
      if (mode === 'EXTERNAL_UPLOAD') return order.externalUploads.length === 0;
      if (mode !== 'REPORTABLE') return false;
      return getExpectedResultTestIds(order).some(
        (testId) => !meaningfulKeys.has(`${order.id}:${testId}`),
      );
    });
    if (incomplete.length > 0) {
      return {
        klass: 'INCOMPLETE',
        pending: incomplete.map((o) => o.testNameSnapshot || o.testCodeSnapshot || o.id),
      };
    }
    return { klass: 'COMPLETE', pending: [] };
  };

  const rows = inScope.map((v) => ({ v, ...classify(v) }));
  const complete = rows.filter((r) => r.klass === 'COMPLETE');
  const incomplete = rows.filter((r) => r.klass === 'INCOMPLETE');
  const noReport = rows.filter((r) => r.klass === 'NO_REPORT');

  const willFinalize = INCLUDE_INCOMPLETE ? [...complete, ...incomplete] : complete;
  const noReportToComplete = COMPLETE_NO_REPORT ? noReport : [];

  console.log('====================================================================');
  console.log(`Branch    : ${branch.name} (${branch.code})  [${branch.id}]`);
  console.log(`Cutoff    : bill sequence < ${BEFORE_SEQ}  (i.e. up to D-${branch.code}-${String(BEFORE_SEQ - 1).padStart(6, '0')})`);
  console.log(`Mode      : ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}  |  silent (no WhatsApp)  |  forced`);
  console.log(`Incompletes: ${INCLUDE_INCOMPLETE ? 'WILL be force-finalized' : 'skipped (default)'}`);
  console.log(`Unfinalized drafts in Balanagar (all bills): ${candidates.length}`);
  console.log(`  in scope (seq < ${BEFORE_SEQ})            : ${inScope.length}`);
  console.log(`    COMPLETE  (finalize)                    : ${complete.length}`);
  console.log(`    INCOMPLETE(pending results)             : ${incomplete.length}  ${INCLUDE_INCOMPLETE ? '(will finalize)' : '(skipped)'}`);
  console.log(`    NO_REPORT (films-only / bill-only)      : ${noReport.length}  ${COMPLETE_NO_REPORT ? '(complete visit, no report)' : '(skipped)'}`);
  console.log(`  >>> WILL FINALIZE (report)                : ${willFinalize.length}`);
  console.log(`  >>> WILL COMPLETE (no-report visit)       : ${noReportToComplete.length}`);
  console.log('--------------------------------------------------------------------');
  const line = (r: { v: (typeof inScope)[number]; klass: Klass; pending: string[] }) =>
    `  ${(r.v.billNumber ?? '(no bill#)').padEnd(14)} | ${(r.v.patient?.name ?? '?').padEnd(24)} | ${r.v.createdAt
      .toISOString()
      .slice(0, 10)} | ${r.klass.padEnd(10)}${r.pending.length ? ' | pending: ' + r.pending.join(', ') : ''}`;
  console.log('COMPLETE (will finalize):');
  complete.forEach((r) => console.log(line(r)));
  if (incomplete.length) {
    console.log(`\nINCOMPLETE (${INCLUDE_INCOMPLETE ? 'will finalize with holes' : 'SKIPPED — pending results'}):`);
    incomplete.forEach((r) => console.log(line(r)));
  }
  if (noReport.length) {
    console.log('\nNO_REPORT (skipped — films-only / bill-only):');
    noReport.forEach((r) => console.log(line(r)));
  }
  console.log('--------------------------------------------------------------------');

  if (!COMMIT) {
    console.log('DRY-RUN only. Re-run with --commit to force-finalize the WILL-FINALIZE set silently.');
    return;
  }

  const { createReportSnapshot, saveReportSnapshot } = await import('../src/services/reportSnapshotService');
  const { createAccessToken } = await import('../src/services/reportAccessService');
  const { derivePayout } = await import('../src/services/payoutService');
  const { logAction } = await import('../src/services/auditService');

  const toProcess = willFinalize.slice(0, LIMIT);
  if (Number.isFinite(LIMIT)) console.log(`(canary/limit: processing only the first ${LIMIT})`);
  let ok = 0;
  let failed = 0;
  const failures: Array<{ bill: string; err: string }> = [];

  for (const { v } of toProcess) {
    const draft = v.report?.versions[0];
    if (!draft) continue;
    const label = v.billNumber ?? v.id;
    try {
      const finalizedAt = new Date();

      // 1. atomic flip (race-safe: only if still DRAFT)
      await prisma.$transaction(async (tx) => {
        const updated = await tx.reportVersion.updateMany({
          where: { id: draft.id, status: 'DRAFT' },
          data: { status: 'FINALIZED', finalizedAt },
        });
        if (updated.count === 0) throw new Error('ALREADY_FINALIZED (raced)');
        await tx.visit.update({ where: { id: v.id }, data: { status: 'COMPLETED' } });
      });

      // 2. snapshot + access token (non-critical — mirrors endpoint try/catch)
      try {
        const snapshot = await createReportSnapshot(draft.id);
        await saveReportSnapshot(draft.id, snapshot);
        await createAccessToken(draft.id);
      } catch (snapErr: any) {
        console.error(`    [snapshot] ${label}: ${snapErr?.message ?? snapErr}`);
      }

      // 3. audit
      await logAction({
        branchId: branch.id,
        actionType: 'FINALIZE',
        entityType: 'Report',
        entityId: draft.id,
        userId: null,
        oldValues: { status: 'DRAFT' },
        newValues: {
          status: 'FINALIZED',
          reportVersionId: draft.id,
          visitId: v.id,
          finalizedAt: finalizedAt.toISOString(),
          via: 'finalize-balanagar-backlog script',
          silent: true,
          forced: true,
        },
      });

      // 4. payout derivation (referral / diagnostic-center) — mirrors endpoint
      const periodStart = new Date(finalizedAt);
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(finalizedAt);
      periodEnd.setHours(23, 59, 59, 999);
      const refId = v.referrals[0]?.referralDoctorId;
      const dcId = v.diagnosticCenterReferrals[0]?.diagnosticCenterId;
      const tasks: Array<Promise<unknown>> = [];
      if (refId) tasks.push(derivePayout('REFERRAL', refId, branch.id, periodStart, periodEnd));
      if (dcId) tasks.push(derivePayout('DIAGNOSTIC_CENTER', dcId, branch.id, periodStart, periodEnd));
      if (tasks.length) await Promise.allSettled(tasks);

      // 5. NO sendReportReady() — silent by design.

      ok++;
      console.log(`  ✓ ${label} finalized (silent)`);
    } catch (err: any) {
      failed++;
      failures.push({ bill: label, err: err?.message ?? String(err) });
      console.error(`  ✗ ${label}: ${err?.message ?? err}`);
    }
  }

  // No-report (films-only / bill-only) completions — endpoint path A: mark the
  // visit COMPLETED WITHOUT finalizing a report version (the DRAFT is left as-is,
  // exactly the films-only end state); no snapshot, no WhatsApp.
  let nrOk = 0;
  let nrFailed = 0;
  const nrToProcess = noReportToComplete.slice(0, LIMIT);
  for (const { v } of nrToProcess) {
    const label = v.billNumber ?? v.id;
    try {
      const completedAt = new Date();
      await prisma.visit.update({ where: { id: v.id }, data: { status: 'COMPLETED' } });
      await logAction({
        branchId: branch.id,
        actionType: 'FINALIZE',
        entityType: 'Visit',
        entityId: v.id,
        userId: null,
        newValues: {
          status: 'COMPLETED',
          noReport: true,
          completedAt: completedAt.toISOString(),
          via: 'finalize-balanagar-backlog script',
          silent: true,
        },
      });
      const periodStart = new Date(completedAt);
      periodStart.setHours(0, 0, 0, 0);
      const periodEnd = new Date(completedAt);
      periodEnd.setHours(23, 59, 59, 999);
      const refId = v.referrals[0]?.referralDoctorId;
      const dcId = v.diagnosticCenterReferrals[0]?.diagnosticCenterId;
      const tasks: Array<Promise<unknown>> = [];
      if (refId) tasks.push(derivePayout('REFERRAL', refId, branch.id, periodStart, periodEnd));
      if (dcId) tasks.push(derivePayout('DIAGNOSTIC_CENTER', dcId, branch.id, periodStart, periodEnd));
      if (tasks.length) await Promise.allSettled(tasks);
      nrOk++;
      console.log(`  ✓ ${label} completed (no-report, silent)`);
    } catch (err: any) {
      nrFailed++;
      failures.push({ bill: label, err: err?.message ?? String(err) });
      console.error(`  ✗ ${label} (no-report): ${err?.message ?? err}`);
    }
  }

  console.log('--------------------------------------------------------------------');
  console.log(`Done. Finalized ${ok}, no-report completed ${nrOk}, failed ${failed + nrFailed}.`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  ${f.bill}: ${f.err}`));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

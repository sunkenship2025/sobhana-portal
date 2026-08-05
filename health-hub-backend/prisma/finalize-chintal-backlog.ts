/**
 * One-off ops script: force-finalize the backlog of DRAFT diagnostic reports
 * in the Sobhana Chintal branch that are older than N days (default 6),
 * SILENTLY (no "report ready" WhatsApp).
 *
 * Mirrors POST /api/visits/diagnostic/:id/finalize EXCEPT:
 *   - skips the INCOMPLETE_REPORT + bill-due guards (forced)
 *   - skips sendReportReady() (silent — patients get NO message)
 *
 * Per visit it does, exactly like the endpoint:
 *   1. reportVersion DRAFT -> FINALIZED (+ finalizedAt), visit -> COMPLETED (atomic)
 *   2. createReportSnapshot -> saveReportSnapshot -> createAccessToken (non-critical)
 *   3. audit log (FINALIZE)
 *   4. derivePayout for any referral doctor / diagnostic-center referral
 *
 * DRY-RUN by default (reads only). Pass --commit to actually write.
 *   npx ts-node --transpile-only prisma/finalize-chintal-backlog.ts            # dry-run
 *   npx ts-node --transpile-only prisma/finalize-chintal-backlog.ts --commit   # execute
 *   ... --days=6   # override the age cutoff
 *
 * DATABASE_URL in .env points at PRODUCTION — treat --commit as a prod write.
 */
import prisma from '../src/lib/prisma';

const COMMIT = process.argv.includes('--commit');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? parseInt(daysArg.split('=')[1], 10) : 6;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

// Visits deliberately reopened (films-only waive undone) — must NOT be re-finalized.
const EXCLUDE_VISIT_IDS = [
  'cmr8vh706054z6scltvp7fto6', // D-CNT-000379 AMBATI SONIKA — ECG reopened
];

async function main() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS);

  const branch = await prisma.branch.findFirst({
    where: { name: { contains: 'Chintal', mode: 'insensitive' as const } },
    select: { id: true, name: true, code: true },
  });
  if (!branch) throw new Error('Chintal branch not found (searched name ILIKE %Chintal%)');

  const visits = await prisma.visit.findMany({
    where: {
      branchId: branch.id,
      domain: 'DIAGNOSTICS',
      id: { notIn: EXCLUDE_VISIT_IDS },
      createdAt: { lt: cutoff },
      status: { notIn: ['CANCELLED', 'COMPLETED'] },
      report: { versions: { some: { status: 'DRAFT' } } },
    },
    select: {
      id: true,
      billNumber: true,
      createdAt: true,
      status: true,
      patient: { select: { name: true } },
      referrals: { where: { deletedAt: null }, select: { referralDoctorId: true } },
      diagnosticCenterReferrals: { select: { diagnosticCenterId: true } },
      report: {
        select: {
          id: true,
          versions: {
            where: { status: 'DRAFT' },
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: { id: true, versionNum: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log('====================================================================');
  console.log(`Branch   : ${branch.name} (${branch.code})  [${branch.id}]`);
  console.log(`Cutoff   : createdAt < ${cutoff.toISOString()}  (older than ${DAYS} days)`);
  console.log(`Mode     : ${COMMIT ? '>>> COMMIT (writing to PROD) <<<' : 'DRY-RUN (no writes)'}  |  silent (no WhatsApp)  |  forced`);
  console.log(`Candidates: ${visits.length} draft diagnostic report(s)`);
  console.log('--------------------------------------------------------------------');
  for (const v of visits) {
    console.log(
      `  ${v.billNumber ?? '(no bill#)'}  |  ${(v.patient?.name ?? '?').padEnd(24)}  |  ${v.createdAt
        .toISOString()
        .slice(0, 10)}  |  visit=${v.status}  |  draftV${v.report?.versions[0]?.versionNum ?? '?'}`,
    );
  }
  console.log('--------------------------------------------------------------------');

  if (!COMMIT) {
    console.log('DRY-RUN only. Re-run with --commit to force-finalize these silently.');
    return;
  }

  const {
    createReportSnapshot,
    saveReportSnapshot,
  } = await import('../src/services/reportSnapshotService');
  const { createAccessToken } = await import('../src/services/reportAccessService');
  const { derivePayout } = await import('../src/services/payoutService');
  const { logAction } = await import('../src/services/auditService');

  const toProcess = visits.slice(0, LIMIT);
  if (Number.isFinite(LIMIT)) console.log(`(canary/limit: processing only the first ${LIMIT})`);
  let ok = 0;
  let failed = 0;
  const failures: Array<{ bill: string; err: string }> = [];

  for (const v of toProcess) {
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
          via: 'finalize-chintal-backlog script',
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

  console.log('--------------------------------------------------------------------');
  console.log(`Done. Finalized ${ok}, failed ${failed}, total ${toProcess.length}.`);
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

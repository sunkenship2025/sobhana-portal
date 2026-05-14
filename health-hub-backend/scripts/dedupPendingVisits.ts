/**
 * One-shot cleanup: remove duplicate DRAFT/WAITING diagnostic visits caused
 * by double-submit on the "Generate Bill & Create Visit" form.
 *
 * Identification rule:
 *   - status IN ('DRAFT', 'WAITING')
 *   - domain = 'DIAGNOSTICS'
 *   - same (patientId, branchId)
 *   - same set of TestOrder testIds (order-insensitive)
 *   - createdAt within 24 hours of another match
 *
 * Keeper preference per duplicate group:
 *   1. Prefer a WAITING (results entered) over a DRAFT (no results)
 *   2. Among same-status rows, keep the most recent createdAt
 *
 * All other rows in the group are deleted. Visit FKs are all
 * `onDelete: Cascade`, so the delete cleans up TestOrder, Bill, Report,
 * ReportVersion, TestResult, Referrals, etc. automatically.
 *
 * Run:
 *   npx tsx scripts/dedupPendingVisits.ts                # dry run
 *   npx tsx scripts/dedupPendingVisits.ts --apply        # commit
 */

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
// Double-submit pattern: same form fired twice in quick succession. 5 min
// is loose enough to catch slow-network retries, tight enough to ignore
// legitimate same-day re-registrations.
const WINDOW_ARG = process.argv.find((a) => a.startsWith('--window-min='));
const WINDOW_MIN = WINDOW_ARG ? Math.max(1, Number(WINDOW_ARG.split('=')[1]) || 5) : 5;
const WINDOW_MS = WINDOW_MIN * 60 * 1000;

type CandidateVisit = {
  id: string;
  billNumber: string;
  patientId: string;
  branchId: string;
  status: string;
  createdAt: Date;
  testOrders: { testId: string }[];
  patient: { name: string };
};

function canonicalTestKey(testOrders: { testId: string }[]): string {
  return [...new Set(testOrders.map(t => t.testId))].sort().join(',');
}

function pickKeeper(group: CandidateVisit[]): CandidateVisit {
  // Prefer WAITING > DRAFT; within same status, prefer most recent.
  const score = (v: CandidateVisit) =>
    (v.status === 'WAITING' ? 1_000_000_000_000 : 0) + v.createdAt.getTime();
  return [...group].sort((a, b) => score(b) - score(a))[0];
}

async function main() {
  const visits = await prisma.visit.findMany({
    where: {
      domain: 'DIAGNOSTICS',
      status: { in: ['DRAFT', 'WAITING'] },
    },
    include: {
      testOrders: { select: { testId: true } },
      patient: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no DB writes)'}`);
  console.log(`Window: ${WINDOW_MIN} minutes (override with --window-min=N)`);
  console.log(`Scanning ${visits.length} DRAFT/WAITING diagnostic visits.\n`);

  // Group by (patient, branch, canonical test key).
  const groups = new Map<string, CandidateVisit[]>();
  for (const v of visits) {
    const key = [v.patientId, v.branchId, canonicalTestKey(v.testOrders)].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(v as CandidateVisit);
  }

  // Filter to only groups with duplicates within the time window.
  const dupGroups: CandidateVisit[][] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Cluster by time window: sort by createdAt and split when gap > WINDOW_MS.
    const sorted = [...group].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    );
    let cluster: CandidateVisit[] = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (curr.createdAt.getTime() - prev.createdAt.getTime() <= WINDOW_MS) {
        cluster.push(curr);
      } else {
        if (cluster.length >= 2) dupGroups.push(cluster);
        cluster = [curr];
      }
    }
    if (cluster.length >= 2) dupGroups.push(cluster);
  }

  if (dupGroups.length === 0) {
    console.log('No duplicate pending visits found.');
    await prisma.$disconnect();
    return;
  }

  let totalToDelete = 0;
  console.log(`Found ${dupGroups.length} duplicate group(s):\n`);

  const toDelete: { visit: CandidateVisit; reason: string }[] = [];

  for (const group of dupGroups) {
    const keeper = pickKeeper(group);
    console.log(
      `  Patient: ${keeper.patient.name}  Tests: ${canonicalTestKey(keeper.testOrders) || '(none)'}`,
    );
    for (const v of group) {
      const isKeeper = v.id === keeper.id;
      const tag = isKeeper ? '  KEEP   ' : '  DELETE ';
      console.log(
        `   ${tag} ${v.billNumber}  status=${v.status}  created=${v.createdAt.toISOString()}`,
      );
      if (!isKeeper) {
        toDelete.push({ visit: v, reason: `dup of ${keeper.billNumber}` });
        totalToDelete++;
      }
    }
    console.log('');
  }

  console.log(`Total visits to delete: ${totalToDelete}\n`);

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to commit deletes.');
    await prisma.$disconnect();
    return;
  }

  console.log('Applying deletes...');
  let deleted = 0;
  for (const { visit, reason } of toDelete) {
    try {
      await prisma.visit.delete({ where: { id: visit.id } });
      deleted++;
      console.log(`  ✓ Deleted ${visit.billNumber} (${reason})`);
    } catch (err: any) {
      console.error(`  ✗ Failed to delete ${visit.billNumber}: ${err.message}`);
    }
  }
  console.log(`\nDone. Deleted ${deleted}/${totalToDelete} duplicate visits.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

/**
 * sync-referral-snapshot — repair finalized reports whose frozen
 * visitSnapshot.referralDoctorName drifted from the live (corrected) referral.
 *
 * Needed only for reports finalized BEFORE the changeVisitReferral snapshot
 * patch shipped; going forward the correction flow keeps them in sync.
 *
 *   npx tsx scripts/sync-referral-snapshot.ts D-BLN-000665           # dry-run
 *   npx tsx scripts/sync-referral-snapshot.ts D-BLN-000665 --apply   # write
 *
 * The LIVE referral (what Patient 360 shows / the list reads) is the source of
 * truth; SELF ⇒ null, which the renderer prints as "SELF".
 */
import prisma from "../src/lib/prisma";
import { deleteCachedMergedPdf } from "../src/services/mergedReportPdfCache";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const billNumber = args.find((a) => !a.startsWith("--"));
  if (!billNumber) {
    console.log("usage: sync-referral-snapshot <billNumber> [--apply]");
    return;
  }

  const visit = await prisma.visit.findFirst({
    where: { billNumber },
    include: {
      referrals: {
        where: { deletedAt: null },
        include: { referralDoctor: { select: { name: true } } },
      },
      report: {
        select: {
          versions: {
            select: { id: true, versionNum: true, status: true, visitSnapshot: true },
          },
        },
      },
    },
  });
  if (!visit) {
    console.log("VISIT NOT FOUND for", billNumber);
    return;
  }

  const liveName = visit.referrals[0]?.referralDoctor?.name ?? null; // null = SELF
  console.log("billNumber:      ", visit.billNumber);
  console.log("visitId:         ", visit.id);
  console.log("LIVE referral:   ", liveName ?? "SELF");

  const patches: { id: string; visitSnapshot: Record<string, unknown> }[] = [];
  const finalizedVersionIds: string[] = [];
  for (const v of visit.report?.versions ?? []) {
    const snap = v.visitSnapshot as Record<string, unknown> | null;
    if (v.status !== "FINALIZED" || !snap) continue;
    finalizedVersionIds.push(v.id);
    const frozen = (snap.referralDoctorName as string | null) ?? null;
    const drift = frozen !== liveName;
    console.log(
      `  v#${v.versionNum} [${v.status}] frozen=${JSON.stringify(frozen)}` +
        (drift ? `  -> will set ${JSON.stringify(liveName)}` : "  (in sync)"),
    );
    if (drift) {
      patches.push({ id: v.id, visitSnapshot: { ...snap, referralDoctorName: liveName } });
    }
  }

  if (finalizedVersionIds.length === 0) {
    console.log("No finalized versions — nothing to fix.");
    return;
  }
  if (!apply) {
    console.log(
      `\nDRY RUN — ${patches.length} snapshot(s) would change; ` +
        `${finalizedVersionIds.length} cached PDF(s) would be busted. Re-run with --apply.`,
    );
    return;
  }
  for (const patch of patches) {
    await prisma.reportVersion.update({
      where: { id: patch.id },
      data: { visitSnapshot: patch.visitSnapshot as any },
    });
  }
  // Always drop the cached PDF for every finalized version (harmless on a fresh
  // entry) so the served download matches the DB — the snapshot may already be
  // in sync from a prior run while the stale PDF still sits in Redis.
  for (const id of finalizedVersionIds) {
    await deleteCachedMergedPdf(id);
  }
  console.log(
    `\nAPPLIED — patched ${patches.length} snapshot(s), invalidated ${finalizedVersionIds.length} cached PDF(s).`,
  );
}

main().finally(() => prisma.$disconnect());

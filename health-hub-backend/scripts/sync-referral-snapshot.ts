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
  for (const v of visit.report?.versions ?? []) {
    const snap = v.visitSnapshot as Record<string, unknown> | null;
    if (v.status !== "FINALIZED" || !snap) continue;
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

  if (patches.length === 0) {
    console.log("Nothing to fix.");
    return;
  }
  if (!apply) {
    console.log(`\nDRY RUN — ${patches.length} version(s) would change. Re-run with --apply to write.`);
    return;
  }
  for (const patch of patches) {
    await prisma.reportVersion.update({
      where: { id: patch.id },
      data: { visitSnapshot: patch.visitSnapshot as any },
    });
  }
  console.log(`\nAPPLIED — patched ${patches.length} version(s).`);
}

main().finally(() => prisma.$disconnect());

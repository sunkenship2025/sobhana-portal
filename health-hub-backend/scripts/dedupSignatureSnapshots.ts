/**
 * One-time backfill: strip `signatureImageBase64` from existing
 * `ReportVersion.signaturesSnapshot` rows.
 *
 * Why: as of the dedup change in saveReportSnapshot, new finalized reports
 * no longer persist signature image bytes (those are hydrated from
 * SigningDoctor at read time). This script applies the same cleanup
 * retroactively to existing rows so you reclaim disk space immediately
 * instead of waiting for organic growth offsets.
 *
 * Safety:
 *   - Does NOT delete rows.
 *   - Does NOT touch panelsSnapshot, patientSnapshot, visitSnapshot, externalUploadsSnapshot.
 *   - Idempotent: running it twice is a no-op (rows already stripped have no base64 to remove).
 *   - Works in batches of 100 to keep memory bounded.
 *   - Reports a row count + total bytes saved at the end.
 *
 * Run:
 *   npx tsx scripts/dedupSignatureSnapshots.ts                # dry run (default)
 *   npx tsx scripts/dedupSignatureSnapshots.ts --apply        # actually write changes
 *   npx tsx scripts/dedupSignatureSnapshots.ts --apply --batch=200
 */

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');
const BATCH_ARG = process.argv.find((a) => a.startsWith('--batch='));
const BATCH_SIZE = BATCH_ARG ? Number(BATCH_ARG.split('=')[1]) || 100 : 100;

interface SignatureLike {
  signatureImageBase64?: string | null;
  [key: string]: unknown;
}

function stripBase64(snapshot: unknown): { stripped: SignatureLike[] | null; bytesSaved: number } {
  if (!Array.isArray(snapshot)) {
    return { stripped: null, bytesSaved: 0 };
  }
  let bytesSaved = 0;
  let mutated = false;
  const cleaned = (snapshot as SignatureLike[]).map((sig) => {
    if (sig && typeof sig === 'object' && typeof sig.signatureImageBase64 === 'string' && sig.signatureImageBase64.length > 0) {
      bytesSaved += sig.signatureImageBase64.length;
      mutated = true;
      const { signatureImageBase64: _omit, ...rest } = sig;
      void _omit;
      return rest;
    }
    return sig;
  });
  return { stripped: mutated ? cleaned : null, bytesSaved };
}

async function main() {
  console.log(`[dedup-signatures] Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} (batch=${BATCH_SIZE})`);
  console.log('[dedup-signatures] Pass --apply to commit changes.\n');

  let cursor: string | undefined = undefined;
  let scanned = 0;
  let mutated = 0;
  let bytesSavedTotal = 0;

  // Loop over ReportVersion rows that have a non-null signaturesSnapshot,
  // ordered by id for stable cursor pagination.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await prisma.reportVersion.findMany({
      where: { signaturesSnapshot: { not: { equals: null as any } } },
      select: { id: true, signaturesSnapshot: true },
      take: BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const row of batch) {
      scanned++;
      const { stripped, bytesSaved } = stripBase64(row.signaturesSnapshot);
      if (!stripped) continue;
      bytesSavedTotal += bytesSaved;
      mutated++;
      if (APPLY) {
        await prisma.reportVersion.update({
          where: { id: row.id },
          data: { signaturesSnapshot: stripped as any },
        });
      }
    }

    process.stdout.write(`  scanned=${scanned} mutated=${mutated} savedKB=${(bytesSavedTotal / 1024).toFixed(1)}\r`);
  }

  console.log('\n');
  console.log(`[dedup-signatures] Done.`);
  console.log(`  Rows scanned:     ${scanned}`);
  console.log(`  Rows that needed dedup: ${mutated}`);
  console.log(`  Total bytes ${APPLY ? 'saved' : 'will-save'}: ${(bytesSavedTotal / (1024 * 1024)).toFixed(2)} MB`);
  if (!APPLY && mutated > 0) {
    console.log(`\n  Dry run only. Re-run with --apply to commit.`);
  }
}

main()
  .catch((err) => {
    console.error('[dedup-signatures] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

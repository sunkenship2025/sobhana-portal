/**
 * "If the doctor writes it as typed, it should be there next time."
 *
 * learnFromSignedPrescription runs after every signature. This proves the three
 * things it promises, end to end through search — a row that exists but cannot
 * be found would pass a count and fail the doctor.
 *
 *   1. A genuinely new medicine, written as typed, becomes a LEARNED row that
 *      the typeahead finds next time.
 *   2. A KNOWN medicine written as typed ("augmentin 625") does NOT mint a
 *      duplicate — the curated row gets the usage.
 *   3. A correction — heard "Aumintin 625", doctor chose Augmentin — becomes an
 *      alias, so the same mishearing resolves by itself next time.
 *
 * Every write is reversed in a finally: the learned row deleted, the alias and
 * usage count put back exactly as found.
 *
 *   npx tsx learning-check.ts
 */
import 'dotenv/config';
import prisma from './src/lib/prisma';
import { learnFromSignedPrescription } from './src/services/voiceRx/learning';
import { resolveMedication, searchMedications } from './src/services/voiceRx/resolver';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const NEW_DRUG = 'Zyxonol 10';
const item = (over: Record<string, unknown>) => ({
  canonicalName: '', spokenText: null, medicationId: null, genericName: null, brandName: null,
  strength: null, strengthUnit: null, dosageForm: null, route: null, resolution: 'MANUAL', ...over,
}) as any;

(async () => {
  const user = await prisma.user.findFirst({ where: { role: 'owner', isActive: true }, select: { id: true } });
  const aug = await prisma.medication.findFirst({
    where: { brandName: { equals: 'Augmentin 625', mode: 'insensitive' }, source: 'CURATED', deletedAt: null },
    select: { id: true, canonicalName: true, aliases: true, usageCount: true, lastUsedAt: true },
  });
  if (!user || !aug) { console.log('no fixture'); process.exit(1); }

  try {
    // ── 1. a new medicine, written as typed ──────────────────────────────────
    // Not "search returns nothing" — search now offers near misses for an unknown
    // word, which is the point. The precondition is that no ROW carries the name.
    assert(`"${NEW_DRUG}" is not in the catalogue yet`,
      !(await searchMedications('zyxonol', 5)).some((c) => c.canonicalName === NEW_DRUG));
    await learnFromSignedPrescription([item({ canonicalName: NEW_DRUG, spokenText: 'zyxonol ten', resolution: 'MANUAL' })], user.id);
    const learned = await prisma.medication.findFirst({ where: { canonicalName: NEW_DRUG, deletedAt: null }, select: { id: true, source: true, aliases: true } });
    assert('…after signing it is a row', !!learned);
    assert('…marked LEARNED, not passed off as curated', learned?.source === 'LEARNED', learned?.source);
    assert('…with what was SPOKEN kept as an alias', !!learned?.aliases.includes('zyxonol ten'), JSON.stringify(learned?.aliases));
    const found = await searchMedications('zyxonol', 5);
    assert('…and the typeahead FINDS it next time', found.some((c) => c.canonicalName === NEW_DRUG), found.map((c) => c.canonicalName).join(' / '));

    // ── 2. a known medicine, written as typed ────────────────────────────────
    const before = await prisma.medication.count({ where: { source: 'LEARNED', canonicalName: { equals: 'augmentin 625', mode: 'insensitive' } } });
    await learnFromSignedPrescription([item({ canonicalName: 'augmentin 625', resolution: 'MANUAL' })], user.id);
    const after = await prisma.medication.count({ where: { source: 'LEARNED', canonicalName: { equals: 'augmentin 625', mode: 'insensitive' } } });
    assert('"augmentin 625" written as typed makes NO duplicate row', after === before, `${before} -> ${after}`);
    const bumped = await prisma.medication.findUnique({ where: { id: aug.id }, select: { usageCount: true } });
    assert('…the curated Augmentin 625 gets the usage instead', bumped!.usageCount === aug.usageCount + 1, `${aug.usageCount} -> ${bumped!.usageCount}`);

    // ── 3. a correction becomes an alias ─────────────────────────────────────
    await learnFromSignedPrescription([item({ canonicalName: aug.canonicalName, medicationId: aug.id, spokenText: 'Aumintin 625', resolution: 'MANUAL' })], user.id);
    const withAlias = await prisma.medication.findUnique({ where: { id: aug.id }, select: { aliases: true } });
    assert('heard "Aumintin 625", chose Augmentin → the mishearing is now an alias', withAlias!.aliases.includes('Aumintin 625'), JSON.stringify(withAlias!.aliases));
    const again: any = await resolveMedication({ spoken: 'Aumintin 625', strength: null, dosageForm: null });
    assert('…so next time "Aumintin 625" resolves to Augmentin by itself', again.resolution === 'RESOLVED' && again.match?.medicationId === aug.id,
      `${again.resolution} ${again.match?.brandName ?? ''}`);
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    await prisma.medication.deleteMany({ where: { canonicalName: NEW_DRUG, source: 'LEARNED' } }).catch(() => {});
    await prisma.medication.update({
      where: { id: aug.id },
      data: { aliases: aug.aliases, usageCount: aug.usageCount, lastUsedAt: aug.lastUsedAt },
    }).catch((e) => { failures += 1; console.error('COULD NOT RESTORE Augmentin 625', e); });
    console.log('\nrestored: learned row deleted, Augmentin 625 aliases and usage as they were');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'all clean' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();

/**
 * Four curated medicines carried another product's name — each a wrong drug the
 * moment a doctor said it:
 *
 *   "combiflam" on Ibuprofen 400 mg        Combiflam is ibuprofen + PARACETAMOL
 *   "pan d"     on Pantoprazole 40 mg      Pan-D is pantoprazole + DOMPERIDONE
 *   "zerodol"   on Aceclofenac + Paracetamol   Zerodol is aceclofenac alone (Zerodol-P is this)
 *   brand "Ultracet" / "ultracet" on Tramadol 50 mg   Ultracet is tramadol + PARACETAMOL
 *
 * Found by listing curated aliases that are another curated product's brand with
 * a different composition (38 hits; the other 34 are one brand across forms —
 * Calpol tablet vs syrup — which strength and form already separate).
 *
 * Dry run by default; --apply writes, with an audit row per medicine.
 *   npx tsx prisma/fix-curated-cross-aliases.ts [--apply]
 */
import 'dotenv/config';
import prisma from '../src/lib/prisma';
import { logAction } from '../src/services/auditService';

const FIXES: { canonicalName: string; dropAliases: string[]; brandName?: string }[] = [
  { canonicalName: 'Ibuprofen 400 mg', dropAliases: ['combiflam'] },
  { canonicalName: 'Pantoprazole 40 mg', dropAliases: ['pan d'] },
  { canonicalName: 'Aceclofenac + Paracetamol 100 mg', dropAliases: ['zerodol'] },
  { canonicalName: 'Tramadol 50 mg', dropAliases: ['ultracet'], brandName: 'Tramazac 50' },
];

(async () => {
  const apply = process.argv.includes('--apply');
  const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
  for (const f of FIXES) {
    const row = await prisma.medication.findFirst({
      where: { deletedAt: null, source: 'CURATED', canonicalName: f.canonicalName },
      select: { id: true, brandName: true, aliases: true },
    });
    if (!row) { console.log(`skip  ${f.canonicalName} — not found`); continue; }
    const aliases = row.aliases.filter((a) => !f.dropAliases.includes(a.toLowerCase()));
    const brandName = f.brandName ?? row.brandName;
    const changed = aliases.length !== row.aliases.length || brandName !== row.brandName;
    console.log(`${changed ? (apply ? 'fix ' : 'would') : 'ok  '}  ${f.canonicalName}: drop [${f.dropAliases.join(', ')}]${f.brandName && f.brandName !== row.brandName ? `, brand ${row.brandName} → ${f.brandName}` : ''}`);
    if (!changed || !apply) continue;
    await prisma.medication.update({ where: { id: row.id }, data: { aliases, brandName } });
    await logAction({
      actionType: 'UPDATE', entityType: 'Medication', entityId: row.id, branchId: branch!.id, userId: null,
      oldValues: { aliases: row.aliases, brandName: row.brandName },
      newValues: { aliases, brandName, reason: 'curated alias named a different product (catalogue fix)' },
    });
  }
  await prisma.$disconnect();
})();

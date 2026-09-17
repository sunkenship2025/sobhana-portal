/** The paged/filtered list must agree with the whole list, and the server's
 *  derived type must match the SQL the filter uses. */
import prisma from './src/lib/prisma';
import { deriveProductType } from './src/routes/billableProducts';

const TYPES = ['EVENT', 'CUSTOM_PACKAGE', 'PANEL_BUNDLE', 'INDIVIDUAL_TEST'] as const;

(async () => {
  let failed = 0;
  const all = await prisma.billableProduct.findMany({
    include: { _count: { select: { panels: true } } },
  });
  const byTs = new Map<string, number>();
  for (const p of all) {
    const t = deriveProductType({
      workflowMode: p.workflowMode, isBundle: p.isBundle, lineCount: p._count.panels,
    });
    byTs.set(t, (byTs.get(t) ?? 0) + 1);
  }
  for (const t of TYPES) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM "BillableProduct" p
      LEFT JOIN (SELECT "productId", count(*) AS n FROM "BillableProductPanel" GROUP BY "productId") l
        ON l."productId" = p.id
      WHERE CASE
        WHEN p."workflowMode" = 'EVENT' THEN 'EVENT'
        WHEN COALESCE(l.n, 0) > 1       THEN 'CUSTOM_PACKAGE'
        WHEN p."isBundle"               THEN 'PANEL_BUNDLE'
        ELSE 'INDIVIDUAL_TEST' END = ${t}`;
    const ts = byTs.get(t) ?? 0;
    const ok = rows.length === ts;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.padEnd(16)} SQL ${String(rows.length).padStart(4)}  TS ${String(ts).padStart(4)}`);
  }
  console.log(failed ? `\n${failed} FAILED` : '\nall clean — SQL filter and deriveProductType agree');
  await prisma.$disconnect(); process.exit(failed ? 1 : 0);
})();

/**
 * Prior values for the same analyte, read from earlier FROZEN snapshots.
 *
 * Reading prior panelsSnapshot rather than joining TestResult avoids the
 * legacy testId / testDefinitionId dual-FK problem entirely — the snapshot
 * already carries testCode, value and unit in the exact shape we want.
 *
 * Only compares when the unit matches. Never converts.
 */
import prisma from '../../lib/prisma';

export interface PriorValue { value: number; unit: string | null; date: string }

export async function loadPriorValues(
  patientId: string,
  beforeVisitCreatedAt: Date,
  excludeVisitId: string,
): Promise<Map<string, PriorValue>> {
  const map = new Map<string, PriorValue>();

  const versions = await prisma.reportVersion.findMany({
    where: {
      status: 'FINALIZED',
      report: {
        visit: {
          patientId,
          id: { not: excludeVisitId },
          createdAt: { lt: beforeVisitCreatedAt },
        },
      },
    },
    orderBy: { finalizedAt: 'desc' },
    take: 3, // most recent few visits is plenty; first hit per analyte wins
    select: { finalizedAt: true, panelsSnapshot: true },
  });

  for (const v of versions) {
    const snap = v.panelsSnapshot as any;
    const date = v.finalizedAt ? v.finalizedAt.toISOString().slice(0, 10) : '';
    for (const dept of snap?.departments ?? []) {
      for (const panel of dept.panels ?? []) {
        for (const t of panel.tests ?? []) {
          if (t.value === null || t.value === undefined) continue;
          if (map.has(t.testCode)) continue; // newest wins
          map.set(t.testCode, { value: t.value, unit: t.referenceUnit ?? null, date });
        }
      }
    }
  }
  return map;
}

/** Attach prior values, but only where the unit is identical. */
export function attachTrends<T extends { code: string; unit: string | null; priorValue: number | null; priorDate: string | null }>(
  findings: T[],
  priors: Map<string, PriorValue>,
): T[] {
  for (const f of findings) {
    const p = priors.get(f.code);
    if (!p) continue;
    if ((p.unit ?? null) !== (f.unit ?? null)) continue; // never convert units
    f.priorValue = p.value;
    f.priorDate = p.date;
  }
  return findings;
}

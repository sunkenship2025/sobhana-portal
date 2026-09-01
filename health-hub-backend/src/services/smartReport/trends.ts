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
import type { TrendPoint } from './types';

export interface PriorValue { value: number; unit: string | null; date: string }

/** One historical reading, carrying the range it was measured against. */
export interface HistoryPoint {
  value: number; unit: string | null; date: string;
  refLow: number | null; refHigh: number | null;
}

/** How many earlier visits a chart may draw on. */
export const HISTORY_VISITS = 6;

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

/**
 * Full series per analyte for the trend charts, oldest first.
 *
 * Reads more visits than loadPriorValues, so it costs more: each row pulls a whole
 * panelsSnapshot. Bounded at HISTORY_VISITS deliberately. If this ever shows up in
 * memory, the fix is a raw jsonb_path_query pulling only the analytes we chart
 * rather than whole snapshots — not worth the complexity until it is measured.
 */
export async function loadHistory(
  patientId: string,
  beforeVisitCreatedAt: Date,
  excludeVisitId: string,
): Promise<Map<string, HistoryPoint[]>> {
  const versions = await prisma.reportVersion.findMany({
    where: {
      status: 'FINALIZED',
      report: {
        visit: { patientId, id: { not: excludeVisitId }, createdAt: { lt: beforeVisitCreatedAt } },
      },
    },
    orderBy: { finalizedAt: 'desc' },
    take: HISTORY_VISITS,
    select: { finalizedAt: true, panelsSnapshot: true },
  });

  const byCode = new Map<string, HistoryPoint[]>();
  const seen = new Set<string>();                       // testCode|date, drops same-day repeats
  for (const v of versions) {                            // newest first
    const date = v.finalizedAt ? v.finalizedAt.toISOString().slice(0, 10) : '';
    if (!date) continue;
    for (const dept of ((v.panelsSnapshot as any)?.departments ?? [])) {
      for (const panel of dept.panels ?? []) {
        for (const t of panel.tests ?? []) {
          if (typeof t.value !== 'number') continue;
          const key = `${t.testCode}|${date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const list = byCode.get(t.testCode) ?? [];
          list.push({
            value: t.value, unit: t.referenceUnit ?? null, date,
            refLow: t.referenceMin ?? null, refHigh: t.referenceMax ?? null,
          });
          byCode.set(t.testCode, list);
        }
      }
    }
  }
  for (const list of byCode.values()) list.reverse();     // oldest first
  return byCode;
}

/**
 * Attach the chartable series. A point is kept only when it is genuinely
 * comparable with today's reading: same unit AND the same reference range.
 *
 * The range check is the one that is easy to skip and wrong to skip. Ranges are
 * resolved by age and sex, so a man's range at 49 can differ from his at 51 —
 * plotting both against one shaded band would quietly compare two different
 * things. Same discipline as never converting units: drop it, don't reconcile it.
 */
export function attachHistory(
  findings: Array<{
    code: string; unit: string | null; value: number;
    refLow: number | null; refHigh: number | null; history: TrendPoint[];
  }>,
  hist: Map<string, HistoryPoint[]>,
): void {
  for (const f of findings) {
    const points = (hist.get(f.code) ?? []).filter((p) =>
      (p.unit ?? null) === (f.unit ?? null)
      && (p.refLow ?? null) === (f.refLow ?? null)
      && (p.refHigh ?? null) === (f.refHigh ?? null));
    // a chart needs at least one prior point besides today's
    f.history = points.length ? [...points.map((p) => ({ value: p.value, date: p.date })), { value: f.value, date: '' }] : [];
  }
}

/**
 * Bucket every row of a frozen report snapshot, and grade how far out each one is.
 *
 * Three buckets, decided per ROW (never per panel — layoutType is a rendering
 * concern, so STANDARD_TABLE and PROCEDURE_STRUCTURED behave identically):
 *   scored          numeric value + numeric range
 *   shownNotScored  has a value but no numeric range (urine chemistry, "Negative")
 *   referredOnly    free-prose panels and external uploads
 */

import type {
  Buckets, Finding, Magnitude, PanelRollup, QualitativeRow, ReferredOnly, FindingStatus,
} from './types';

const NARRATIVE_LAYOUTS = new Set(['TEXT_ONLY', 'IMAGING_NARRATIVE']);

/** Inside the range but within this fraction of the span from a boundary reads
 *  "Borderline". 10% not 5%: uric acid 6.9 in 3.5-7.2 sits 8% from the top and is
 *  genuinely worth flagging. Strict `<` so an exactly-on-the-line value stays normal. */
const BORDERLINE_FRACTION = 0.10;
/** deviation -> points. Tuned so ~50% out reaches the cap of 6. */
const POINTS_PER_DEVIATION = 12;
const MAX_POINTS = 6;

export function magnitudeOf(deviation: number): Magnitude {
  if (deviation < 0.10) return 'SLIGHT';
  if (deviation <= 0.30) return 'MODERATE';
  return 'MARKED';
}

/** Without a critical bound, this much past the limit is as far as we will read. */
const SEVERE_DEVIATION = 1.0;
/**
 * Ceiling on severity we are willing to INFER. 58% above the limit is an
 * emergency for haemoglobin and unremarkable for LDL, and nothing in the result
 * itself tells us which. So a test with no clinician-set critical bound can never
 * be called worse than moderate, and the way to let a test drive the score down
 * is to give it critical bounds in the catalog — a clinical decision, not ours.
 */
const INFERRED_SEVERITY_CAP = 0.5;
/** Borderline sits inside its range — it should nudge the score, not dent it. */
const BORDERLINE_SEVERITY = 0.05;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Severity is what a clinician would recognise, not what the arithmetic says.
 * Where the catalog defines a critical bound we scale against it, so haemoglobin
 * 7.2 against a critical floor of 7.0 reads as near-maximal rather than as a
 * middling 45% deviation. Without a critical bound we fall back to the deviation.
 */
export function severityOf(
  t: { referenceMin: number | null; referenceMax: number | null; criticalMin: number | null; criticalMax: number | null },
  value: number, status: FindingStatus, deviation: number,
): number {
  if (status === 'CRITICAL_HIGH' || status === 'CRITICAL_LOW') return 1;
  if (status === 'BORDERLINE') return BORDERLINE_SEVERITY;
  const { referenceMin: lo, referenceMax: hi, criticalMin: cLo, criticalMax: cHi } = t;
  if (hi !== null && value > hi && cHi !== null && cHi > hi) return clamp01((value - hi) / (cHi - hi));
  if (lo !== null && value < lo && cLo !== null && cLo < lo) return clamp01((lo - value) / (lo - cLo));
  return Math.min(INFERRED_SEVERITY_CAP, clamp01(deviation / SEVERE_DEVIATION));
}

export function pointsFor(deviation: number): number {
  return Math.max(1, Math.min(MAX_POINTS, Math.round(deviation * POINTS_PER_DEVIATION)));
}

export function labelFor(status: FindingStatus, magnitude: Magnitude): string {
  if (status === 'CRITICAL_HIGH') return 'Critically high';
  if (status === 'CRITICAL_LOW') return 'Critically low';
  if (status === 'BORDERLINE') return 'Borderline';
  const low = status === 'LOW';
  if (magnitude === 'SLIGHT') return low ? 'Slightly low' : 'Slightly high';
  if (magnitude === 'MARKED') return low ? 'Very low' : 'Very high';
  return low ? 'Low' : 'High';
}

/** Snapshot row shape we care about (reportSnapshotService.TestResultSnapshot). */
interface SnapshotTest {
  testCode: string;
  testName: string;
  value: number | null;
  textValue?: string | null;
  flag: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceText: string | null;
  referenceUnit: string | null;
  criticalMin: number | null;
  criticalMax: number | null;
}
interface SnapshotPanel {
  panelId: string;
  displayName: string;
  panelName?: string;
  layoutType: string;
  icon?: string | null;
  tests: SnapshotTest[];
}
interface SnapshotDepartment { panels: SnapshotPanel[] }
export interface SnapshotLike {
  departments: SnapshotDepartment[];
  externalUploads?: { productName: string }[];
}

/**
 * @param inScopePanelIds  panels belonging to a Smart-Report-enabled package.
 *                         Anything outside is listed as "reported separately".
 */
export function buildBuckets(
  snapshot: SnapshotLike,
  inScopePanelIds: Set<string> | null,
): Buckets {
  const findings: Finding[] = [];   // out of range -> get cards
  const borderline: Finding[] = []; // inside the range, near a limit -> counts only, no card
  const withinRange: Finding[] = [];
  const qualitative: QualitativeRow[] = [];
  const referred: ReferredOnly[] = [];
  const panels: PanelRollup[] = [];
  const seenTestCodes = new Set<string>();
  let hasCritical = false;
  let measured = 0;

  for (const dept of snapshot.departments ?? []) {
    for (const panel of dept.panels ?? []) {
      if (inScopePanelIds && !inScopePanelIds.has(panel.panelId)) {
        referred.push({ name: panel.displayName, reason: 'NARRATIVE_PANEL' });
        continue;
      }
      if (NARRATIVE_LAYOUTS.has(panel.layoutType)) {
        referred.push({ name: panel.displayName, reason: 'NARRATIVE_PANEL' });
        continue;
      }

      const rollup: PanelRollup = {
        panelId: panel.panelId,
        name: panel.displayName,
        icon: panel.icon ?? null,
        withinRange: 0, outOfRange: 0, borderline: 0, notScored: 0,
      };

      for (const t of panel.tests ?? []) {
        const hasNumber = t.value !== null && t.value !== undefined && Number.isFinite(t.value);
        const hasText = typeof t.textValue === 'string' && t.textValue.trim() !== '';
        if (!hasNumber && !hasText) continue; // not resulted — never counted

        // Same analyte can appear in two packages on one visit; count it once.
        if (seenTestCodes.has(t.testCode)) continue;
        seenTestCodes.add(t.testCode);
        measured += 1;

        const lo = t.referenceMin;
        const hi = t.referenceMax;
        const scoreable = hasNumber && (lo !== null || hi !== null);

        if (!scoreable) {
          qualitative.push({
            code: t.testCode,
            name: t.testName,
            panel: panel.displayName,
            value: hasText ? String(t.textValue).trim() : String(t.value),
            expected: t.referenceText ?? null,
          });
          rollup.notScored += 1;
          continue;
        }

        const value = t.value as number;
        const critical =
          (t.criticalMin !== null && value < t.criticalMin) ||
          (t.criticalMax !== null && value > t.criticalMax) ||
          t.flag === 'CRITICAL_HIGH' || t.flag === 'CRITICAL_LOW';

        let status: FindingStatus | null = null;
        let limit: number | null = null;
        let deviationRaw = 0;

        if (hi !== null && value > hi) { status = 'HIGH'; limit = hi; deviationRaw = value - hi; }
        else if (lo !== null && value < lo) { status = 'LOW'; limit = lo; deviationRaw = lo - value; }

        if (status === null) {
          // Inside the range. Borderline when it sits within 5% of a boundary.
          const span = lo !== null && hi !== null ? hi - lo : Math.abs(hi ?? lo ?? 1);
          const nearHi = hi !== null && hi - value < span * BORDERLINE_FRACTION;
          const nearLo = lo !== null && value - lo < span * BORDERLINE_FRACTION;
          const f = baseFinding(t, panel, value, 'BORDERLINE', 0, 1);
          if (nearHi || nearLo) { borderline.push(f); rollup.borderline += 1; }
          else { withinRange.push({ ...f, status: 'BORDERLINE', label: 'Normal', points: 0 }); rollup.withinRange += 1; }
          continue;
        }

        const denom = Math.abs(limit as number) || Math.abs((hi ?? 0) - (lo ?? 0)) || 1;
        const deviation = deviationRaw / denom;
        const finalStatus: FindingStatus = critical
          ? (status === 'HIGH' ? 'CRITICAL_HIGH' : 'CRITICAL_LOW')
          : status;
        if (critical) hasCritical = true;
        findings.push(baseFinding(t, panel, value, finalStatus, deviation, pointsFor(deviation)));
        rollup.outOfRange += 1;
      }

      if (rollup.withinRange + rollup.outOfRange + rollup.borderline + rollup.notScored > 0) {
        panels.push(rollup);
      }
    }
  }

  for (const up of snapshot.externalUploads ?? []) {
    referred.push({ name: up.productName, reason: 'EXTERNAL_UPLOAD' });
  }

  // Worst first: critical, then by points, then by deviation.
  findings.sort((a, b) => {
    const crit = Number(b.status.startsWith('CRITICAL')) - Number(a.status.startsWith('CRITICAL'));
    return crit || b.points - a.points || b.deviation - a.deviation;
  });

  const counts = {
    measured,
    scored: findings.length + borderline.length + withinRange.length,
    outOfRange: findings.length,
    borderline: borderline.length,
    withinRange: withinRange.length,
    shownNotScored: qualitative.length,
    referredOnly: referred.length,
  };

  return { findings, borderline, withinRange, qualitative, referred, panels, counts, hasCritical };
}

function baseFinding(
  t: SnapshotTest, panel: SnapshotPanel, value: number,
  status: FindingStatus, deviation: number, points: number,
): Finding {
  const magnitude = magnitudeOf(deviation);
  return {
    code: t.testCode,
    name: t.testName,
    panel: panel.displayName,
    panelId: panel.panelId,
    value,
    unit: t.referenceUnit ?? null,
    refLow: t.referenceMin,
    refHigh: t.referenceMax,
    status,
    deviation,
    magnitude,
    points,
    severity: severityOf(t, value, status, deviation),
    label: labelFor(status, magnitude),
    priorValue: null,
    priorDate: null,
    ruleId: null,
    needsExplanation: true,
    explanation: null,
  };
}

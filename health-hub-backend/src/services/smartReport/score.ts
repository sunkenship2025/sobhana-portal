/**
 * Health score. Deliberately explainable: points are proportional to how far a
 * result sits outside its range, and no single panel can cost more than 10.
 *
 * Score and the panel tiles are BOTH projections of one finding set, so they can
 * never disagree — the reference report we cloned prints "all 89 normal, 100%"
 * beside tiles reading "7 Abnormal", which is the failure this prevents.
 */

import type { Finding, ScoreBand } from './types';

const PANEL_CAP = 10;

export interface ScoreResult {
  score: number;
  band: ScoreBand;
  deduction: number;
  perPanel: Record<string, number>;
}

export function computeScore(findings: Finding[]): ScoreResult {
  const perPanel: Record<string, number> = {};
  for (const f of findings) {
    perPanel[f.panelId] = (perPanel[f.panelId] ?? 0) + f.points;
  }
  const capped = Object.fromEntries(
    Object.entries(perPanel).map(([k, v]) => [k, Math.min(PANEL_CAP, v)]),
  );
  const deduction = Object.values(capped).reduce((a, b) => a + b, 0);
  const score = Math.max(0, 100 - deduction);
  return { score, band: bandFor(score), deduction, perPanel: capped };
}

export function bandFor(score: number): ScoreBand {
  if (score >= 90) return 'ON_TRACK';
  if (score >= 75) return 'MOSTLY_ON_TRACK';
  if (score >= 50) return 'NEEDS_WORK';
  return 'SEE_DOCTOR';
}

export const BAND_LABEL: Record<ScoreBand, string> = {
  ON_TRACK: 'On track',
  MOSTLY_ON_TRACK: 'Mostly on track',
  NEEDS_WORK: 'Several things to work on',
  SEE_DOCTOR: 'Please see your doctor soon',
};

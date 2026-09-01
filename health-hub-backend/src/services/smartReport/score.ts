/**
 * Health score. Deliberately explainable, and deliberately pessimistic about the
 * worst result in the report.
 *
 * The score is a projection of ONE finding set, the same set the panel tiles are
 * drawn from, so the two can never disagree — the reference report we cloned
 * prints "all 89 normal, 100%" beside tiles reading "7 Abnormal".
 *
 * Two forces, and severity always wins:
 *
 *   CEILING   The worst single finding caps the score. A clinician reading the
 *             page judges the report by its worst value; so must we. This is the
 *             property that matters commercially — a report saying "90 / 100, on
 *             track" beside a haemoglobin of 7.2 discredits the centre with the
 *             referring doctor far more than a low number ever could.
 *
 *   BREADTH   Within that ceiling, the score falls with the share of everything
 *             measured that came back off, so twelve mild flags read worse than
 *             two.
 *
 * The earlier model summed capped points, which meant the floor was
 * 100 - 10 x panelCount: a single-panel package could not score below 90 no
 * matter how severe the result. That is the bug this replaces.
 */

import type { Finding, ScoreBand } from './types';

/** Worst-finding severity -> the highest score the report may report. */
const CEILINGS: Array<[number, number]> = [
  [1.00, 30],   // at or past a critical bound
  [0.75, 45],
  [0.50, 62],
  [0.25, 78],
  [0.00, 92],   // anything abnormal at all keeps it out of a perfect score
];

/** Never print 0 / 100 at a person. */
const MIN_SCORE = 5;

/**
 * When most of what we measured came back outside its range, that breadth is
 * itself a finding — a clinician acts on "many systems off at once" even when no
 * single value is alarming. Above this share the ceiling tightens by one tier.
 * Set above one-half deliberately: an even split is the reference health-check
 * patient, who genuinely is a "several things to work on" and not an emergency.
 */
const CROWDED_SHARE = 0.6;

/**
 * ...but only once enough was measured for a share to mean anything. One
 * abnormal result out of one is 100%, and says nothing about breadth.
 */
const CROWDED_MIN_SCORED = 8;

export interface ScoreResult {
  score: number;
  band: ScoreBand;
  ceiling: number;
  worstSeverity: number;
  breadth: number;
  crowded: boolean;
}

/** One tier stricter, for reports where nearly everything came back off. */
function tighten(ceiling: number): number {
  const tiers = CEILINGS.map(([, c]) => c);
  const i = tiers.indexOf(ceiling);
  return i > 0 ? tiers[i - 1] : ceiling;
}

export function ceilingFor(worstSeverity: number): number {
  for (const [threshold, ceiling] of CEILINGS) {
    if (worstSeverity >= threshold && worstSeverity > 0) return ceiling;
  }
  return 100;
}

/**
 * @param findings   abnormal + borderline findings (never the within-range rows)
 * @param scoredCount every row that carried a numeric range, including normal ones
 */
export function computeScore(findings: Finding[], scoredCount: number): ScoreResult {
  if (!findings.length || scoredCount <= 0) {
    return { score: 100, band: bandFor(100), ceiling: 100, worstSeverity: 0, breadth: 0, crowded: false };
  }
  const worstSeverity = findings.reduce((m, f) => Math.max(m, f.severity), 0);
  const abnormal = findings.filter((f) => f.severity > 0.05).length;
  const crowded = scoredCount >= CROWDED_MIN_SCORED && abnormal / scoredCount > CROWDED_SHARE;
  const ceiling = crowded ? tighten(ceilingFor(worstSeverity)) : ceilingFor(worstSeverity);
  const breadth = findings.reduce((n, f) => n + f.severity, 0) / scoredCount;
  const score = Math.max(MIN_SCORE, Math.min(ceiling, 100 - Math.round(breadth * 100)));
  return { score, band: bandFor(score), ceiling, worstSeverity, breadth, crowded };
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

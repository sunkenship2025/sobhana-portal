/**
 * Smart Reports — shared types.
 *
 * The deterministic layer decides every fact; the LLM only chooses words.
 * See SMART_REPORTS_PLAN.md and SMART_REPORTS_AI_SPEC.md.
 */

export type FindingStatus =
  | 'HIGH'
  | 'LOW'
  | 'BORDERLINE'
  | 'CRITICAL_HIGH'
  | 'CRITICAL_LOW';

/** <10% past the limit reads "Slightly", 10-30% plain, >30% "Very". */
export type Magnitude = 'SLIGHT' | 'MODERATE' | 'MARKED';

export interface Finding {
  code: string;
  name: string;
  panel: string;
  panelId: string;
  value: number;
  unit: string | null;
  refLow: number | null;
  refHigh: number | null;
  status: FindingStatus;
  /** |value - nearest limit| / |limit|. Drives BOTH the points and the wording. */
  deviation: number;
  magnitude: Magnitude;
  /** clamp(round(deviation * 12), 1, 6); borderline = 1. */
  points: number;
  /**
   * 0..1, how serious this result is. Anchored to the clinician-set critical
   * bound when the catalog has one (value AT the critical bound = 1.0), else to
   * a 60%-past-the-limit fallback. This, not the point count, drives the score.
   */
  severity: number;
  label: string;
  priorValue: number | null;
  priorDate: string | null;
  /** Oldest -> newest, current visit last. Only points that are truly comparable:
   *  same unit AND same reference range. Empty when there is no usable history. */
  history: TrendPoint[];
  ruleId: string | null;
  needsExplanation: boolean;
  explanation: string | null;
}

/** Has a value but no numeric range — shown beside its expected value, never judged. */
export interface QualitativeRow {
  code: string;
  name: string;
  panel: string;
  value: string;
  expected: string | null;
}

/** Free-prose panels and external uploads: named, never interpreted. */
export interface ReferredOnly {
  name: string;
  reason: 'NARRATIVE_PANEL' | 'EXTERNAL_UPLOAD';
}

export interface PanelRollup {
  panelId: string;
  name: string;
  icon: string | null;
  withinRange: number;
  outOfRange: number;
  borderline: number;
  notScored: number;
}

export interface TrendPoint { value: number; date: string }

export interface Counts {
  measured: number;
  scored: number;
  outOfRange: number;
  borderline: number;
  withinRange: number;
  shownNotScored: number;
  referredOnly: number;
}

export type ScoreBand = 'ON_TRACK' | 'MOSTLY_ON_TRACK' | 'NEEDS_WORK' | 'SEE_DOCTOR';

export interface Buckets {
  /** Out of range only — these get cards. */
  findings: Finding[];
  /** Inside the range but near a limit: counted and tiled, never carded. */
  borderline: Finding[];
  qualitative: QualitativeRow[];
  referred: ReferredOnly[];
  withinRange: Finding[];
  panels: PanelRollup[];
  counts: Counts;
  hasCritical: boolean;
}

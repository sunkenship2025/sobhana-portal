/**
 * The de-identified payload. Nothing identifying is ever sent to the model:
 * no name, patient number, phone, address, visit/bill number, branch or doctor.
 * It gets an age band, sex and the finding set — everything it needs to write copy.
 *
 * Matters doubly because the provider is overseas. Asserted by assertDeidentified().
 */
import type { Finding, Counts, ScoreBand } from './types';
import type { ContentLine, FollowUp } from './content';

export const PROMPT_VERSION = 'sr-1';

export interface PayloadFinding {
  code: string; name: string; panel: string;
  value: number; unit: string | null;
  refLow: number | null; refHigh: number | null;
  status: string; label: string;
  priorValue: number | null; priorDate: string | null;
  needsExplanation: boolean;
}

export interface SmartReportPayload {
  ageBand: string;
  sex: 'M' | 'F' | 'O';
  packageName: string;
  counts: Counts;
  score: number;
  scoreBand: ScoreBand;
  findings: PayloadFinding[];
  contentLines: ContentLine[];
  followUps: FollowUp[];
  language: string;
}

export function ageBandOf(age: number | null): string {
  if (age === null) return 'adult';
  const lo = Math.floor(age / 10) * 10;
  return `${lo}-${lo + 9}`;
}

export function buildPayload(input: {
  age: number | null;
  sex: string;
  packageName: string;
  counts: Counts;
  score: number;
  scoreBand: ScoreBand;
  findings: Finding[];
  contentLines: ContentLine[];
  followUps: FollowUp[];
  language: string;
}): SmartReportPayload {
  return {
    ageBand: ageBandOf(input.age),
    sex: (['M', 'F', 'O'].includes(input.sex) ? input.sex : 'O') as 'M' | 'F' | 'O',
    packageName: input.packageName,
    counts: input.counts,
    score: input.score,
    scoreBand: input.scoreBand,
    findings: input.findings.map((f) => ({
      code: f.code, name: f.name, panel: f.panel,
      value: f.value, unit: f.unit, refLow: f.refLow, refHigh: f.refHigh,
      status: f.status, label: f.label,
      priorValue: f.priorValue, priorDate: f.priorDate,
      needsExplanation: f.needsExplanation,
    })),
    contentLines: input.contentLines,
    followUps: input.followUps,
    language: input.language,
  };
}

/** Throws if anything identifying leaked in. Called before every request. */
export function assertDeidentified(payload: SmartReportPayload, forbidden: string[]): void {
  const blob = JSON.stringify(payload).toLowerCase();
  for (const raw of forbidden) {
    const needle = (raw ?? '').toString().trim().toLowerCase();
    if (needle.length < 3) continue;
    if (blob.includes(needle)) {
      throw new Error(`Smart Report payload leaked an identifier: "${raw}"`);
    }
  }
}

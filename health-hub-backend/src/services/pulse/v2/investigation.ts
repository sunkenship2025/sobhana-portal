/**
 * INVESTIGATION STATE — what is still unknown that would change the answer.
 *
 * What this replaces: a boolean. The loop asked the analyst "is this enough?" and continued while
 * it said no. That is a vibe check, and it produces answer generation rather than analysis: the
 * model stops when it feels satisfied, which is usually as soon as it has a number.
 *
 * A real analyst does not stop when it has a number. Asked why collections fell 12%, it forms an
 * objective, proposes the ways a decline can happen — branch, referrer, service mix, volume
 * versus realisation, one-off events — and then spends queries closing them off. "70% of the fall
 * is two branches" does not end the investigation; it opens the next one, because branch-driven
 * and volume-driven are different claims and only one more query separates them.
 *
 * So the loop now carries hypotheses with a status, the unknowns that remain material, and any
 * contradictions between steps. Continuing is a consequence of something being unresolved, not of
 * the model's appetite; stopping is a consequence of nothing cheap being left that would change
 * the conclusion. The state also travels to the responder, which is what lets the answer say
 * "primarily volume-driven, concentrated in two branches" instead of reciting the decomposition.
 */

export type HypothesisStatus = 'open' | 'confirmed' | 'rejected';

export interface Hypothesis {
  id: string;
  /** a claim that could be true or false, not a topic — "the fall is volume, not price" */
  claim: string;
  status: HypothesisStatus;
  /** evidence step indices that bear on it */
  evidence?: number[];
  note?: string;
  /** would resolving this change what the owner is told? */
  material?: boolean;
}

export interface Investigation {
  objective: string;
  hypotheses: Hypothesis[];
  /** material unknowns not yet expressed as a hypothesis */
  unresolved: string[];
  /** steps that disagree — worth surfacing rather than silently averaging away */
  contradictions: string[];
  confidence: 'low' | 'medium' | 'high';
}

export const emptyInvestigation = (objective = ''): Investigation =>
  ({ objective, hypotheses: [], unresolved: [], contradictions: [], confidence: 'low' });

const STATUSES: HypothesisStatus[] = ['open', 'confirmed', 'rejected'];

/** Accept only what the shape allows; a malformed round must not poison the state. */
export function normalise(raw: any, fallbackObjective = ''): Investigation {
  const inv = emptyInvestigation(String(raw?.objective || fallbackObjective || '').slice(0, 300));
  const hs = Array.isArray(raw?.hypotheses) ? raw.hypotheses : [];
  inv.hypotheses = hs.slice(0, 8).map((h: any, i: number) => ({
    id: String(h?.id || `h${i + 1}`).slice(0, 12),
    claim: String(h?.claim || '').slice(0, 240),
    status: STATUSES.includes(h?.status) ? h.status : 'open',
    evidence: Array.isArray(h?.evidence) ? h.evidence.map(Number).filter(Number.isFinite).slice(0, 8) : [],
    note: h?.note ? String(h.note).slice(0, 240) : undefined,
    material: h?.material !== false,
  })).filter((h: Hypothesis) => h.claim);
  inv.unresolved = (Array.isArray(raw?.unresolved) ? raw.unresolved : []).map((u: any) => String(u).slice(0, 200)).filter(Boolean).slice(0, 6);
  inv.contradictions = (Array.isArray(raw?.contradictions) ? raw.contradictions : []).map((c: any) => String(c).slice(0, 240)).filter(Boolean).slice(0, 4);
  inv.confidence = ['low', 'medium', 'high'].includes(raw?.confidence) ? raw.confidence : 'low';
  return inv;
}

/**
 * Carry state across rounds. A hypothesis already settled stays settled unless this round
 * explicitly overturns it — otherwise the model relitigates what it closed two queries ago and
 * the loop never converges.
 */
export function merge(prev: Investigation | null, next: Investigation): Investigation {
  if (!prev) return next;
  const byId = new Map(prev.hypotheses.map((h) => [h.id, h]));
  for (const h of next.hypotheses) {
    const was = byId.get(h.id);
    // a settled claim may be reopened only by an explicit new verdict, never by silence
    byId.set(h.id, was && was.status !== 'open' && h.status === 'open' ? was : h);
  }
  return {
    objective: next.objective || prev.objective,
    hypotheses: [...byId.values()].slice(0, 10),
    unresolved: next.unresolved,
    contradictions: [...new Set([...prev.contradictions, ...next.contradictions])].slice(0, 4),
    confidence: next.confidence,
  };
}

export const openMaterial = (inv: Investigation | null): Hypothesis[] =>
  (inv?.hypotheses || []).filter((h) => h.status === 'open' && h.material !== false);

/**
 * Is the objective answered? Not "does the model feel done" — nothing material is still open, or
 * the evidence already supports a confident conclusion.
 */
export function resolved(inv: Investigation | null): boolean {
  if (!inv) return true;
  if (inv.confidence === 'high' && !inv.contradictions.length) return true;
  return openMaterial(inv).length === 0 && inv.unresolved.length === 0;
}

/** What the responder is told, so the conclusion is about the objective and not about the rows. */
export function brief(inv: Investigation | null): any {
  if (!inv || !inv.hypotheses.length) return undefined;
  const pick = (s: HypothesisStatus) => inv.hypotheses.filter((h) => h.status === s).map((h) => h.claim);
  return {
    objective: inv.objective,
    established: pick('confirmed'),
    ruledOut: pick('rejected'),
    stillOpen: openMaterial(inv).map((h) => h.claim),
    contradictions: inv.contradictions,
    confidence: inv.confidence,
  };
}

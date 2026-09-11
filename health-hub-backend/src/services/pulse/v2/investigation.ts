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

/** A named piece of analysis a claim depends on. Structured, so coverage is checkable rather
 *  than a matter of trusting that the model meant it. */
export interface Requirement { tool: string; metric?: string; dimension?: string; note?: string }

export interface Hypothesis {
  id: string;
  /** what this claim needs before it may be called settled */
  requires?: Requirement[];
  /** a claim that could be true or false, not a topic — "the fall is volume, not price" */
  claim: string;
  status: HypothesisStatus;
  /** evidence step indices that bear on it */
  evidence?: number[];
  note?: string;
  /** would resolving this change what the owner is told? */
  material?: boolean;
}

export type StoppingReason = 'resolved' | 'insufficient_evidence' | 'stagnation' | 'resource_limit';

export interface Investigation {
  objective: string;
  /** false when we stopped with something material still open */
  complete?: boolean;
  /** why we stopped — "we could not investigate further" is itself analytical information */
  stoppingReason?: StoppingReason;
  hypotheses: Hypothesis[];
  /** material unknowns not yet expressed as a hypothesis */
  unresolved: string[];
  /** steps that disagree — worth surfacing rather than silently averaging away */
  contradictions: string[];
  confidence: 'low' | 'medium' | 'high';
}

export const emptyInvestigation = (objective = ''): Investigation =>
  ({ objective, hypotheses: [], unresolved: [], contradictions: [], confidence: 'low' });

/**
 * Why the loop stopped, and whether that counts as finished. The old code broke out when the
 * model proposed no next step, which silently turned "I could not investigate this" into "I am
 * done" — the comment claimed the invariant was "continue while something MATERIAL is open" but
 * the implementation was "continue if the model suggested something". Those are not the same,
 * and the difference is whether the owner is told the answer is incomplete.
 */
export function conclude(inv: Investigation | null, reason: StoppingReason): Investigation | null {
  if (!inv) return inv;
  const open = openMaterial(inv).length > 0 || inv.unresolved.length > 0;
  return { ...inv, complete: !open, stoppingReason: open ? reason : 'resolved' };
}

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
    requires: (Array.isArray(h?.requires) ? h.requires : []).slice(0, 4)
      .map((r: any) => ({ tool: String(r?.tool || ''), metric: r?.metric ? String(r.metric) : undefined,
        dimension: r?.dimension ? String(r.dimension) : undefined }))
      .filter((r: Requirement) => r.tool),
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
  // Ids are regenerated every round, so the same claim comes back under a new id and reappears as
  // open after it was settled — one run showed "Discount given is a material recoverable amount"
  // as rejected AND open at once, which is not a disagreement, it is a bookkeeping error.
  const byClaim = new Map<string, Hypothesis>();
  for (const h of byId.values()) {
    const prev2 = byClaim.get(norm(h.claim));
    byClaim.set(norm(h.claim), !prev2 ? h : prev2.status !== 'open' ? prev2 : h);
  }
  return {
    objective: next.objective || prev.objective,
    hypotheses: [...byClaim.values()].slice(0, 10),
    unresolved: next.unresolved,
    contradictions: [...new Set([...prev.contradictions, ...next.contradictions])].slice(0, 4),
    confidence: next.confidence,
  };
}

export const openMaterial = (inv: Investigation | null): Hypothesis[] =>
  (inv?.hypotheses || []).filter((h) => h.status === 'open' && h.material !== false);

/** Which of a claim's requirements the evidence actually satisfies. */
export function coverage(h: Hypothesis, evidence: { ok: boolean; tool: string; metric?: any; dimension?: any }[]) {
  const reqs = h.requires || [];
  const missing = reqs.filter((r) => !evidence.some((e) => e.ok
    && String(e.tool) === String(r.tool)
    && (!r.metric || String(e.metric || '') === String(r.metric))
    && (!r.dimension || String(e.dimension || '') === String(r.dimension))));
  return { total: reqs.length, missing };
}

/**
 * The deterministic gate. The prompt tells the model it is not deciding whether it FEELS
 * finished — but the loop then stopped because the model returned an empty "next", which is the
 * same judgment wearing a structured coat. A claim may only be called settled when the analysis
 * it said it needed actually ran; otherwise it goes back to open, and the loop cannot stop.
 *
 * This is what turns "CNT gives ₹76k in discounts" into "CNT gives ₹76k, of which ₹X is
 * realistically recoverable" — the second requires a step the first never had to take.
 */
export function enforce(inv: Investigation, evidence: { ok: boolean; tool: string; metric?: any; dimension?: any }[]):
  { inv: Investigation; downgraded: { id: string; missing: Requirement[] }[] } {
  const downgraded: { id: string; missing: Requirement[] }[] = [];
  const hypotheses = inv.hypotheses.map((h) => {
    if (h.status === 'open' || !h.requires?.length) return h;
    const { missing } = coverage(h, evidence);
    if (!missing.length) return h;
    downgraded.push({ id: h.id, missing });
    return { ...h, status: 'open' as const, note: `unsupported: ${missing.map((m) => m.tool + (m.dimension ? ` by ${m.dimension}` : '')).join(', ')} never ran` };
  });
  return { inv: { ...inv, hypotheses }, downgraded };
}

/**
 * Is the objective answered? Not "does the model feel done" — nothing material is still open, or
 * the evidence already supports a confident conclusion.
 */
export function resolved(inv: Investigation | null): boolean {
  if (!inv) return true;
  // Confidence is the model's opinion and cannot on its own end an investigation with a material
  // claim still open — that was the loophole: high confidence short-circuited everything.
  return openMaterial(inv).length === 0 && inv.unresolved.length === 0;
}

/** What the responder is told, so the conclusion is about the objective and not about the rows. */
export function brief(inv: Investigation | null): any {
  if (!inv || !inv.hypotheses.length) return undefined;
  const pick = (s: HypothesisStatus) => inv.hypotheses.filter((h) => h.status === s).map((h) => h.claim);
  return {
    objective: inv.objective,
    complete: inv.complete !== false,
    stoppingReason: inv.stoppingReason,
    established: pick('confirmed'),
    ruledOut: pick('rejected'),
    stillOpen: openMaterial(inv).map((h) => h.claim),
    contradictions: inv.contradictions,
    confidence: inv.confidence,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * CONVERGENCE — why the loop stops.
 *
 * It used to stop on a count: eight rounds, thirty calls. A count cannot tell an investigation
 * that is working from one that is stuck, so it punishes both. Asked how to grow the business,
 * the loop spent eight rounds on the two hypotheses that mattered and was cut off with exactly
 * those two open, at 82s of a 180s budget — while a different question could burn the same
 * budget on thirty queries that establish nothing.
 *
 * "I have done enough analysis" is not "I have used enough queries". A question may deserve four
 * queries or thirty; what the controller can actually observe is whether a round CHANGED WHAT WE
 * KNOW. So progress is measured, not counted: new evidence, requirements satisfied, material
 * claims settled, dimensions not looked at before — against duplicates and rounds that produced
 * nothing. Stopping normally means resolved, or demonstrably stagnating. The ceilings stay, but
 * only as an emergency brake, and hitting one is disclosed rather than presented as a finish.
 *
 * The model may propose; it may not declare itself done. That decision is deterministic and
 * lives here.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */

/** What a round changed. Every field is observed, none is the model's opinion. */
export interface RoundProgress {
  newEvidence: number;
  duplicates: number;
  failed: number;
  requirementsSatisfied: number;
  resolvedMaterial: number;
  openedMaterial: number;
  newDimensions: number;
  /** reducing uncertainty earns; repeating yourself costs */
  gain: number;
  /** what we knew at the end of the round — identical signatures across rounds is thrashing */
  state: string;
}

/** Result identity. Two different queries that bring back the same rows are the same knowledge,
 *  which is the thing being detected — so this hashes what came back, not what was asked. */
export function evidenceSignature(e: any): string {
  const rows = Array.isArray(e?.data?.rows) ? e.data.rows : [];
  return [e?.tool, e?.metric ?? '', e?.dimension ?? '', e?.period ?? '',
    JSON.stringify(e?.scope ?? e?.filter ?? null), rows.length,
    JSON.stringify(rows.slice(0, 6)), JSON.stringify(e?.summary ?? null)].join('|').slice(0, 3000);
}

const norm = (x: string) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

/** What we believe, order-independent. Unchanged across rounds despite new queries = thrashing. */
export function stateSignature(inv: Investigation | null): string {
  return JSON.stringify({
    h: (inv?.hypotheses || []).map((h) => `${h.status}:${norm(h.claim)}`).sort(),
    u: (inv?.unresolved || []).map(norm).sort(),
  });
}

/** Requirements still unmet across the material claims — the thing a productive round reduces. */
export const missingRequirements = (inv: Investigation | null, evidence: any[]): number =>
  openMaterial(inv).reduce((n, h) => n + coverage(h, evidence).missing.length, 0);

/**
 * Score a round. The weights say what the system is FOR: settling a material question is worth
 * more than any amount of new evidence, and asking the same thing again is worth less than
 * nothing. They are not calibrated constants — they encode an ordering, and only the sign and
 * the ranking matter to `stagnating`.
 */
export function measure(o: {
  got: any[];
  seen: Set<string>;                       // mutated: signatures already returned
  dims: Set<string>;                       // mutated: dimensions already explored
  before: Map<string, HypothesisStatus>;
  missingBefore: number;
  inv: Investigation;
  evidence: any[];
}): RoundProgress {
  let newEvidence = 0, duplicates = 0, failed = 0, newDimensions = 0;
  for (const e of o.got) {
    if (!e?.ok) { failed++; continue; }
    const sig = evidenceSignature(e);
    if (o.seen.has(sig)) duplicates++; else { o.seen.add(sig); newEvidence++; }
    const d = `${e.tool}:${e.dimension ?? ''}:${e.metric ?? ''}`;
    if (!o.dims.has(d)) { o.dims.add(d); newDimensions++; }
  }
  let resolvedMaterial = 0, openedMaterial = 0;
  for (const h of o.inv.hypotheses) {
    if (h.material === false) continue;
    const was = o.before.get(h.id);
    if (h.status !== 'open' && was !== h.status) resolvedMaterial++;
    if (h.status === 'open' && was === undefined) openedMaterial++;
  }
  const requirementsSatisfied = Math.max(0, o.missingBefore - missingRequirements(o.inv, o.evidence));
  const gain = 5 * newEvidence + 10 * resolvedMaterial + 4 * requirementsSatisfied
    + 3 * newDimensions - 5 * duplicates - 3 * failed;
  return { newEvidence, duplicates, failed, requirementsSatisfied, resolvedMaterial,
    openedMaterial, newDimensions, gain, state: stateSignature(o.inv) };
}

/**
 * Has the investigation stopped moving? A window, not a single repeat — one barren round is
 * normal (the analyst may change approach), and stopping on it would reintroduce the cap in a
 * new costume. Two independent signals, either of which is enough:
 *   · no round in the window earned anything
 *   · what we believe has not changed in the window, however many queries ran
 * The second is the one that catches thrashing: revenue by branch, by doctor, by branch again,
 * each returning rows, none of it settling anything.
 */
export function stagnating(history: RoundProgress[], window = 3): boolean {
  if (history.length < window) return false;
  const last = history.slice(-window);
  if (last.every((p) => p.gain <= 0)) return true;
  return last.every((p) => p.state === last[0].state) && last.every((p) => p.resolvedMaterial === 0);
}

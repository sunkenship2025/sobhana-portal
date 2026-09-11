/**
 * OPPORTUNITIES — what is worth doing, sized in rupees, ranked by the system rather than by how
 * actionable a thing happens to sound.
 *
 * The failure this exists to kill: asked how to make more money, Pulse led with report open
 * rates. The gap was real — 59% of finalised reports are opened — and the recommendation was
 * worthless. Closing the entire gap is worth about ₹7,400 over 45 days under the most generous
 * possible assumption (that the whole observed return-rate difference is causal, which it is
 * not, because people who open reports are the engaged ones who would have come back anyway).
 * Discounting over the same period is ₹1,05,035. Pulse ranked the ₹7,400 idea above the
 * ₹1,05,035 one because it sounded like something you could go and do on Monday.
 *
 * So an opportunity is no longer a sentence. It is an object that has to carry what it is worth,
 * over what period, how that was worked out, and whether the link is OBSERVED, MODELLED or
 * CAUSAL. A modelled number is never stated as money the owner will receive.
 *
 * Ranking is deterministic and shown. Impact first, confidence second — which is not the whole
 * answer (a ₹1L problem nobody can change should lose to a ₹30k one fixable tomorrow, and
 * addressability belongs in the formula eventually) but it is already far better than ranking by
 * what sounds actionable.
 */

export type Causality = 'observed' | 'modeled' | 'causal';
export type Confidence = 'low' | 'medium' | 'high';

export interface Opportunity {
  title: string;
  /** what is wrong, in the owner's terms */
  problem: string;
  /** the figure that establishes the problem exists */
  evidence: string;
  /** what would actually be changed */
  lever: string;
  /** what the problem is worth today, e.g. "₹1,05,035 in 30 days" */
  currentValue?: string;
  /** what could realistically be recovered or gained */
  estimatedImpact?: string;
  impactPeriod?: string;
  /** how the estimate was arrived at — required, because an unexplained number is a guess */
  impactMethod: string;
  assumptions?: string[];
  causality: Causality;
  confidence: Confidence;
}

const CONF: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.3 };
/** A modelled number is a scenario, not money in hand; a causal one has been tested. */
const CAUSE: Record<Causality, number> = { causal: 1, observed: 0.8, modeled: 0.35 };

/** Rupees out of "₹1,05,035 in 30 days" / "₹7.4k" / "₹1.2L". */
export function rupees(s?: string): number {
  if (!s) return 0;
  const m = String(s).match(/₹\s?([\d,]+(?:\.\d+)?)\s*(k|l|lakh|cr|crore)?/i);
  if (!m) return 0;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const u = (m[2] || '').toLowerCase();
  return u === 'k' ? n * 1e3 : u.startsWith('l') ? n * 1e5 : u.startsWith('c') ? n * 1e7 : n;
}

export interface RankedOpportunity extends Opportunity {
  /** what it is worth, discounted for how much we believe it */
  weight: number;
  rupeeValue: number;
  /** the ranking, in words, so the owner can disagree with it */
  why: string;
}

/**
 * Impact first, confidence second. The weight is shown, not hidden, because a ranking the owner
 * cannot argue with is a ranking they cannot trust.
 */
export interface Ranked { recommended: RankedOpportunity[]; considered: Opportunity[] }

/**
 * Sized and unsized are different kinds of thing and do not belong in one ordered list. An
 * unsized candidate ranked at zero still LOOKS like a recommendation sitting at the bottom of
 * the recommendations — and the whole point of sizing is that you may not recommend what you
 * have not measured. It stays visible as something that was considered, which is information
 * the owner wants, without pretending to be advice.
 */
export function rank(list: Opportunity[]): Ranked {
  const valued = (o: Opportunity) => rupees(o.estimatedImpact) || rupees(o.currentValue);
  const considered = (list || []).filter((o) => o && o.title && !valued(o)).slice(0, 4);
  const recommended = rankAll((list || []).filter((o) => o && o.title && valued(o)));
  return { recommended, considered };
}

function rankAll(list: Opportunity[]): RankedOpportunity[] {
  return list
    .map((o) => {
      const rupeeValue = rupees(o.estimatedImpact) || rupees(o.currentValue);
      const conf = CONF[o.confidence] ?? 0.3;
      const cause = CAUSE[o.causality] ?? 0.35;
      const why = o.causality === 'modeled'
        ? `${o.estimatedImpact || 'unsized'} — modelled, so treat as an upper bound, not money you will receive`
        : `${o.estimatedImpact || o.currentValue || 'unsized'} — ${o.causality}, ${o.confidence} confidence`;
      return { ...o, rupeeValue, weight: Math.round(rupeeValue * conf * cause), why };
    })
    .sort((a, b) => b.weight - a.weight || b.rupeeValue - a.rupeeValue)
    .slice(0, 6);
}

/** A modelled estimate must never be phrased as money the owner will get. */
export function honestImpact(o: Opportunity): string {
  if (!o.estimatedImpact) return 'not sized';
  if (o.causality === 'modeled') {
    return `up to ${o.estimatedImpact}${o.impactPeriod ? ` over ${o.impactPeriod}` : ''}, and only if the whole observed effect is causal — it is a scenario, not incremental revenue`;
  }
  return `${o.estimatedImpact}${o.impactPeriod ? ` over ${o.impactPeriod}` : ''}`;
}

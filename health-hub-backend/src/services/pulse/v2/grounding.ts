/**
 * GROUNDING — is every figure in the answer one the analysis actually produced, or derivable
 * from figures it produced by an operation we can check?
 *
 * What this replaces: a proximity test. The previous check asked "does this number appear
 * somewhere in the evidence, within 1%" — over a pile that also contained every value divided
 * and multiplied by a hundred, to tolerate paise. That is an enormous equivalence class. It
 * caught the blatant case (a fabricated ₹12,79,750) and could say nothing useful about a bare
 * 72, and it could never catch the more interesting error: every number present, the
 * RELATIONSHIP between them invented. "₹76,275 is 72.6% of ₹1,05,035" has three real figures and
 * one claim, and only the claim can be wrong.
 *
 * So a figure is grounded when it is:
 *   EXACT     the same value a step produced, allowing for rounding and paise/rupee display
 *   DERIVED   obtainable from two such values by an operation an analyst would actually use —
 *             a share, a difference, a sum, a ratio, a percentage change
 *   ordinary  a small count, a year, a period length: "three levers", "30 days", "2026"
 *
 * Anything else is stated without support, and the answer is sent back to be rewritten.
 *
 * Derivation is deliberately shallow. Two-term arithmetic over the facts of one turn covers what
 * an analyst writes in a sentence; searching deeper would start "proving" coincidences, and a
 * grounding check that accepts almost everything is the proximity test again with more steps.
 */

/** One number the analysis produced, with where it came from. */
export interface Fact {
  step: number;
  tool: string;
  /** the key it sat under — "discount_total", "openRatePct", "value" */
  label: string;
  value: number;
  /** what it means, carried from the step */
  means?: string;
}

export type Provenance =
  | { kind: 'exact'; fact: Fact }
  | { kind: 'derived'; how: string; from: Fact[] }
  | { kind: 'ordinary'; why: string }
  | { kind: 'ungrounded' };

export interface GroundedNumber { text: string; value: number; provenance: Provenance }

const MAX_FACTS = 160;

/** Pull every number a step produced, keeping the key it came from. */
export function factsOf(evidence: any[]): Fact[] {
  const out: Fact[] = [];
  for (const e of evidence || []) {
    if (!e?.ok) continue;
    const walk = (x: any, label: string, depth: number) => {
      if (x == null || out.length >= MAX_FACTS || depth > 4) return;
      if (typeof x === 'number') {
        if (Number.isFinite(x)) out.push({ step: e.step, tool: e.tool, label, value: Math.abs(x), means: e.means });
        return;
      }
      if (typeof x === 'string') {
        // a formatted figure — "₹1,05,035", "36.3%", "6h"
        const m = x.match(/^[\s₹$]*(-?[\d,]+(?:\.\d+)?)\s*[%h]?\s*$/);
        if (m) { const n = Number(m[1].replace(/,/g, '')); if (Number.isFinite(n)) out.push({ step: e.step, tool: e.tool, label, value: Math.abs(n), means: e.means }); }
        return;
      }
      if (Array.isArray(x)) { x.slice(0, 30).forEach((v, i) => walk(v, label, depth + 1)); return; }
      if (typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, k, depth + 1);
    };
    walk(e.summary, 'summary', 0);
    walk((e.data as any)?.rows, 'row', 0);
  }
  return out;
}

const close = (a: number, b: number, tol = 0.011) =>
  a === b || (Math.max(Math.abs(a), Math.abs(b)) > 0 && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) <= tol);

/** Paise and rupees are the same fact wearing different units; nothing else is. */
const sameFigure = (n: number, f: number) => close(n, f) || close(n, f / 100) || close(n * 100, f);

/**
 * Could an analyst have got this number from two the analysis produced? Shares, differences,
 * sums and percentage changes — the arithmetic that actually appears in a sentence.
 */
function derive(n: number, facts: Fact[]): Provenance | null {
  const near = (v: number) => close(n, v);
  for (let i = 0; i < facts.length; i++) {
    const a = facts[i];
    for (let j = 0; j < facts.length; j++) {
      if (i === j) continue;
      const b = facts[j];
      if (b.value !== 0) {
        if (near(a.value / b.value * 100)) return { kind: 'derived', how: `${a.label} as a share of ${b.label}`, from: [a, b] };
        if (near((a.value - b.value) / b.value * 100)) return { kind: 'derived', how: `change from ${b.label} to ${a.label}`, from: [a, b] };
        if (near(a.value / b.value)) return { kind: 'derived', how: `${a.label} per ${b.label}`, from: [a, b] };
      }
      if (near(a.value - b.value)) return { kind: 'derived', how: `${a.label} minus ${b.label}`, from: [a, b] };
      if (near(a.value + b.value)) return { kind: 'derived', how: `${a.label} plus ${b.label}`, from: [a, b] };
    }
  }
  return null;
}

/** Numbers that are not claims about the data: counts you can hold in a hand, years, periods. */
function ordinary(text: string, raw: string, n: number): string | null {
  if (Number.isInteger(n) && n <= 12) return 'a small count';
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return 'a year';
  const at = text.indexOf(raw);
  const after = at >= 0 ? text.slice(at + raw.length, at + raw.length + 18) : '';
  if (/^\s*(day|days|week|weeks|month|months|hour|hours|year|years|am|pm|st|nd|rd|th)\b/i.test(after)) return 'a period';
  return null;
}

/** Every figure the prose states, and where each one came from. */
export function groundNumbers(text: string, evidence: any[]): GroundedNumber[] {
  const facts = factsOf(evidence);
  const out: GroundedNumber[] = [];
  const seen = new Set<string>();
  const RE = /₹\s?([\d,]+(?:\.\d+)?)|\b(\d[\d,]*(?:\.\d+)?)\s?%|\b(\d[\d,]*(?:\.\d+)?)\b/g;

  for (const m of String(text || '').matchAll(RE)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const value = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;

    const why = ordinary(text, m[0], value);
    if (why) { out.push({ text: m[0], value, provenance: { kind: 'ordinary', why } }); continue; }

    const hit = facts.find((f) => sameFigure(value, f.value));
    if (hit) { out.push({ text: m[0], value, provenance: { kind: 'exact', fact: hit } }); continue; }

    const d = facts.length ? derive(value, facts) : null;
    out.push({ text: m[0], value, provenance: d ?? { kind: 'ungrounded' } });
  }
  return out;
}

/** The figures stated without support, for the repair instruction. */
export const unsupported = (g: GroundedNumber[]) =>
  g.filter((x) => x.provenance.kind === 'ungrounded').map((x) => x.text);

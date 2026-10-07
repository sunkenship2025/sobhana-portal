/**
 * FIGURES BY REFERENCE. Every figure the evidence supports gets an id and its formatted value; the
 * writer writes {F3}, never a digit, and the server fills the value in. A number the model copies
 * by hand can be 100x out, rounded wrong or invented, and 48% of answers needed a second model call
 * to repair that; a number it points at can only be the one the step measured.
 */
import type { Evidence } from './tools';

export interface Fact { id: string; label: string; value: string }

const PCT = /pct|percent|share/i;
const leaf = (k: string, v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return PCT.test(k) ? `${v}%` : v.toLocaleString('en-IN');
  if (typeof v === 'string' && /\d/.test(v) && v.length <= 60) return v;
  return null;
};
const nameOf = (r: any) => r?.name ?? r?.k ?? r?.label ?? r?.patient ?? r?.branch ?? null;

/** One flat, labelled list from every usable step. Long row lists are summarised, not exploded —
 *  rows belong in the card, not the prose. */
export function factsOf(evidence: Evidence[], cap = 120): Fact[] {
  const out: Fact[] = [];
  const add = (label: string, value: string) => { if (out.length < cap) out.push({ id: `F${out.length + 1}`, label, value }); };
  for (const e of evidence) {
    if (!e.ok || e.summary == null) continue;
    const base = [e.label, e.scope, typeof e.period === 'object' && (e.period as any)?.from ? `${(e.period as any).from} to ${(e.period as any).to}` : null].filter(Boolean).join(' · ');
    const walk = (v: any, path: string) => {
      if (v == null) return;
      if (Array.isArray(v)) {
        v.slice(0, 8).forEach((x, i) => walk(x, `${path}[${nameOf(x) ?? i + 1}]`));
        if (v.length > 8) add(`${base} — ${path}: rows`, String(v.length));
        return;
      }
      if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) if (!['metric', 'by', 'scope', 'period', 'bucket', 'comparison', 'matched'].includes(k)) walk(x, path ? `${path}.${k}` : k); return; }
      const s = leaf(path.split('.').pop() || '', v);
      if (s) add(`${base} — ${path}`, s);
    };
    walk(e.summary, '');
  }
  return out;
}

const REF = /[{[]\s*F(\d+)\s*[}\]]/g;
/** Fill {F3} with its value. An id that does not exist is dropped and reported, never guessed. */
export function fill(text: unknown, facts: Fact[], missing: string[]): any {
  if (typeof text !== 'string') return text;
  return text.replace(REF, (_m, n) => {
    const f = facts[Number(n) - 1];
    if (!f) { missing.push(`F${n}`); return ''; }
    return f.value;
  }).replace(/\s{2,}/g, ' ').trim();
}

/** Every string field the writer returns, filled. */
export function withFigures(res: any, facts: Fact[]): { res: any; missing: string[] } {
  const missing: string[] = [];
  if (!res || typeof res !== 'object') return { res, missing };
  const f = (x: unknown) => fill(x, facts, missing);
  const out = { ...res, text: f(res.text), verdict: f(res.verdict), caveat: f(res.caveat), action: f(res.action),
    points: Array.isArray(res.points) ? res.points.map((p: any) => ({ ...p, text: f(p?.text), label: f(p?.label) })) : res.points,
    opportunities: Array.isArray(res.opportunities) ? res.opportunities.map((o: any) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]))) : res.opportunities };
  return { res: out, missing };
}

/** The table the writer is given — id, value, what it is. */
export const factTable = (facts: Fact[]) => facts.map((f) => `${f.id} = ${f.value}   (${f.label})`).join('\n');

// self-check: node -e "require('ts-node/register/transpile-only'); require('./src/services/pulse/v2/facts').selfCheck()"
export function selfCheck(): void {
  const ev: any[] = [{ ok: true, step: 0, label: 'CT collection', scope: 'modality=CT / MRI', summary: { value: '₹98,067', changePct: 12.5, parts: [{ name: 'CNT', value: '₹60,000' }] } }];
  const facts = factsOf(ev);
  const want = (c: boolean, m: string) => { if (!c) throw new Error(m); };
  want(facts.some((x) => x.value === '₹98,067'), 'value fact');
  want(facts.some((x) => x.value === '12.5%'), 'pct fact');
  want(facts.some((x) => x.label.includes('[CNT]')), 'row named by its name');
  const { res, missing } = withFigures({ verdict: 'CT brought in {F1}, {F2} up.', points: [{ text: 'see [F9]' }] }, facts);
  want(res.verdict === 'CT brought in ₹98,067, 12.5% up.', `filled: ${res.verdict}`);
  want(missing.length === 1 && missing[0] === 'F9' && res.points[0].text === 'see', 'unknown id dropped and reported');
  console.log('facts self-check ok');
}

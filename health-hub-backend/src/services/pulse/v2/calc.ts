/**
 * ARITHMETIC OVER EVIDENCE ALREADY ON THE TABLE.
 *
 * The writer is forbidden to compute — "never divide or multiply a figure you were given" — and
 * that rule is correct: a model doing arithmetic in prose is how a figure lands 100x out as a
 * real rupee claim. But the rule had no counterpart. Asked for a CT payback period with CT
 * revenue, CT commission and the ₹50,00,000 price all present and correct, the answer was
 * "I could not establish it". The operands were there. One subtraction and one division were
 * missing, and there was nowhere for them to happen.
 *
 * `derive` was the nearest thing and could not reach: it divides one NAMED METRIC by another,
 * so it cannot subtract, cannot take a number the owner supplied, and cannot touch a figure a
 * previous step already measured.
 *
 * This is that missing place. The model writes a formula and names its operands; the arithmetic
 * runs HERE, in TypeScript, over values read out of prior evidence. The model never states a
 * computed number — it reads one back like any other evidence.
 *
 * MONEY IS THE TRAP. Evidence carries money as PAISE in `data`; a price the owner typed is in
 * RUPEES. Adding those gives an answer 100x wrong that looks entirely plausible, which is the
 * worst kind. Every operand is normalised to rupees on the way in, and where a unit cannot be
 * established the operand is refused rather than assumed.
 */

export type Operand = { step?: number; field?: string; value?: number; unit?: string; means?: string };

/* ── a restricted evaluator ────────────────────────────────────────────────────────────────
   Recursive descent over + - * / ( ) and names. NOT eval, and not `new Function`: the formula
   is model-authored text, and handing model-authored text to a JS engine is a remote-execution
   hole dressed up as convenience. Nothing here can call anything. */
type Tok = { t: 'num' | 'name' | 'op' | 'par'; v: string };
function lex(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)?|[-+*/()])/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) throw new Error(`cannot read "${s.slice(i, i + 12)}" in the formula`);
    i = re.lastIndex;
    const v = m[1];
    out.push({ t: /^[A-Za-z_]/.test(v) ? 'name' : /^[\d.]/.test(v) ? 'num' : v === '(' || v === ')' ? 'par' : 'op', v });
  }
  return out;
}
export function evaluate(formula: string, vars: Record<string, number>): number {
  const toks = lex(formula);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v: string) => { if (toks[p]?.v === v) { p++; return true; } return false; };
  const primary = (): number => {
    if (eat('(')) { const v = expr(); if (!eat(')')) throw new Error('unbalanced brackets in the formula'); return v; }
    if (eat('-')) return -primary();
    const t = toks[p++];
    if (!t) throw new Error('the formula ends early');
    if (t.t === 'num') return Number(t.v);
    if (t.t === 'name') {
      if (!(t.v in vars)) throw new Error(`the formula uses "${t.v}" but no operand of that name was given`);
      return vars[t.v];
    }
    throw new Error(`unexpected "${t.v}" in the formula`);
  };
  const term = (): number => {
    let v = primary();
    for (;;) {
      if (eat('*')) v *= primary();
      else if (eat('/')) { const d = primary(); if (!d) throw new Error('the formula divides by zero'); v /= d; }
      else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    for (;;) { if (eat('+')) v += term(); else if (eat('-')) v -= term(); else return v; }
  };
  const v = expr();
  if (p < toks.length) throw new Error(`trailing "${peek()?.v}" in the formula`);
  if (!Number.isFinite(v)) throw new Error('the formula does not produce a finite number');
  return v;
}

/* ── reading a number out of a step ───────────────────────────────────────────────────────── */
const NUMERIC = (x: any) => typeof x === 'number' && Number.isFinite(x);

/** The headline figure of a step, and the unit it is in. A step that carries a split rather than
 *  one number has no headline, and says so — picking a row silently would answer a different
 *  question from the one the formula asked. */
export function figureOf(e: any, field?: string): { v: number; unit?: string } | string {
  if (!e) return 'that step does not exist';
  if (e.ok === false) return `step ${e.step} failed, so it carries no figure`;
  const d = e.data, s = e.summary;
  if (field) {
    for (const src of [d, s, d?.[0], s?.[0]]) if (src && NUMERIC(src[field])) return { v: src[field], unit: e.unit };
    return `step ${e.step} has no numeric field "${field}"`;
  }
  for (const c of [d?.value, s?.value, d?.total, s?.total, NUMERIC(d) ? d : undefined]) if (NUMERIC(c)) return { v: c, unit: e.unit };
  // a single-row, single-measure step still has an unambiguous headline
  const rows = d?.rows ?? (Array.isArray(d) ? d : null);
  if (Array.isArray(rows) && rows.length === 1) {
    const nums = Object.entries(rows[0]).filter(([, v]) => NUMERIC(v));
    if (nums.length === 1) return { v: nums[0][1] as number, unit: e.unit };
  }
  return `step ${e.step} carries no single figure to compute with — name a field, or use a step that measures one number`;
}

const MONEY = (u?: string | null) => u === 'paise' || u === 'rupees' || u === 'money';
/** to rupees. Evidence money is paise; a number the owner supplied is rupees. */
const toRupees = (v: number, unit?: string | null) => (unit === 'paise' ? v / 100 : v);

export const rupees = (v: number) =>
  '₹' + Math.round(v).toLocaleString('en-IN');

export async function t_compute(a: any, _k: any, prior: any[] = []): Promise<any> {
  const formula = String(a?.formula || '').trim();
  if (!formula) return { ok: false, error: 'compute needs a formula' };
  const decl = a?.let || a?.operands || {};
  if (!decl || typeof decl !== 'object' || !Object.keys(decl).length)
    return { ok: false, error: 'compute needs operands — name each one and say which step it comes from' };

  const vars: Record<string, number> = {};
  const basis: string[] = [];
  const inputs: any[] = [];
  for (const [name, raw] of Object.entries(decl as Record<string, Operand>)) {
    const o = (raw || {}) as Operand;
    let v: number, unit: string | undefined, where: string;
    if (NUMERIC(o.value)) {
      v = o.value as number;
      unit = o.unit || 'number';
      if (MONEY(unit) && unit !== 'rupees') return { ok: false, error: `operand "${name}" is money the owner supplied — give it in rupees` };
      where = o.means || 'given in the question';
    } else if (Number.isInteger(o.step)) {
      const e = prior.find((x) => x?.step === o.step);
      const got = figureOf(e, o.field);
      if (typeof got === 'string') return { ok: false, error: `operand "${name}": ${got}` };
      v = toRupees(got.v, got.unit);
      unit = MONEY(got.unit) ? 'rupees' : (got.unit || 'number');
      where = `step ${o.step}${e?.label ? ` — ${e.label}` : ''}`;
      inputs.push({ name, step: o.step, means: e?.means });
    } else {
      return { ok: false, error: `operand "${name}" needs either a "step" to read from or a literal "value"` };
    }
    vars[name] = v;
    basis.push(`${name} = ${MONEY(unit) ? rupees(v) : Number(v).toLocaleString('en-IN')} (${where})`);
  }

  let value: number;
  try { value = evaluate(formula, vars); } catch (err: any) { return { ok: false, error: String(err?.message || err) }; }

  const unit = String(a?.unit || 'number');
  const shown = MONEY(unit) ? rupees(value)
    : unit === 'percent' ? `${(value * (Math.abs(value) <= 1 ? 100 : 1)).toFixed(1)}%`
    : /month|year|day|week/.test(unit) ? `${value.toFixed(1)} ${unit}`
    : Number(value.toFixed(2)).toLocaleString('en-IN');

  return {
    ok: true,
    unit: MONEY(unit) ? 'rupees' : unit,
    means: String(a?.means || '').trim() || `${formula}, computed from the steps named below`,
    detail: `${formula} = ${shown}`,
    summary: { computed: formula, value: shown, basis },
    data: { value, formula, vars, inputs },
  };
}

/**
 * WHICH PREDICATES ACTUALLY RESTRICT THE ANSWER.
 *
 * verifySpec asks "does this constraint appear in the SQL" — a string search. That is not the
 * question. The question is whether the constraint restricts the rows the final number is
 * computed from, and the two come apart in exactly the case where being wrong is invisible:
 *
 *   WITH filtered AS (SELECT * FROM "TestOrder" WHERE "testCodeSnapshot" = 'CTBP')
 *   SELECT SUM(o."priceInPaise") FROM "TestOrder" o
 *
 * The literal is right there. The CTE is never referenced. The total is over every order ever
 * placed, and a string search calls it correct. Nothing downstream would catch it — the number is
 * plausible, grounded (it really is a figure a step produced) and wrong.
 *
 * So: parse, then walk outward from the statement that produces the result, through only what it
 * actually reads — base tables, referenced CTEs, subqueries, join conditions. Predicates found on
 * that walk are effective. Predicates anywhere else are decoration.
 *
 * A parse failure is never a rejection. The generator writes Postgres this parser may not cover,
 * and a validator that rejects a query it merely failed to understand is the JGG mistake again:
 * a guard that can refuse a good answer but cannot confirm a bad one. On a parse failure the
 * caller falls back to the string check — weaker, but never wrong in the strict direction.
 */
import { parse } from 'pgsql-ast-parser';

export interface Predicate { column: string; values: string[] }
export interface Scope {
  /** false when the SQL did not parse — the caller must fall back, not reject */
  parsed: boolean;
  /** predicates on relations the final result is actually computed from */
  effective: Predicate[];
  /** base tables the result reads */
  tables: Set<string>;
}

/** Every `col = 'x'` and `col IN ('x','y')` inside one expression. */
function predicatesIn(expr: any, out: Predicate[], depth = 0): void {
  if (!expr || typeof expr !== 'object' || depth > 24) return;
  if (expr.type === 'binary' && expr.op === '=') {
    const [ref, lit] = expr.left?.type === 'ref' ? [expr.left, expr.right] : [expr.right, expr.left];
    if (ref?.type === 'ref' && ref.name && (lit?.type === 'string' || lit?.type === 'integer'))
      out.push({ column: String(ref.name), values: [String(lit.value)] });
  }
  // IN is a binary node with a `list` on the right, not a node type of its own
  if (expr.type === 'binary' && /^in$/i.test(String(expr.op || '')) && expr.left?.type === 'ref'
      && expr.right?.type === 'list' && Array.isArray(expr.right.expressions))
    out.push({ column: String(expr.left.name),
      values: expr.right.expressions.filter((x: any) => x?.type === 'string' || x?.type === 'integer').map((x: any) => String(x.value)) });
  for (const v of Object.values(expr)) {
    if (Array.isArray(v)) for (const x of v) predicatesIn(x, out, depth + 1);
    else if (v && typeof v === 'object') predicatesIn(v, out, depth + 1);
  }
}

/**
 * Walk the result-producing statement through what it reads. A CTE contributes its predicates
 * only when something references it.
 *
 * ponytail: UNION is treated as reachable on both sides, so a constraint on one branch counts.
 * That is the permissive direction — it can miss a half-filtered union, never reject a correct
 * query. Tighten it if a union ever shows up in a real plan; none has yet.
 */
function walk(stmt: any, ctes: Map<string, any>, preds: Predicate[], tables: Set<string>, seen: Set<string>, depth = 0): void {
  if (!stmt || typeof stmt !== 'object' || depth > 12) return;
  if (stmt.type === 'union' || stmt.type === 'union all') {
    walk(stmt.left, ctes, preds, tables, seen, depth + 1);
    walk(stmt.right, ctes, preds, tables, seen, depth + 1);
    return;
  }
  if (stmt.where) predicatesIn(stmt.where, preds);
  for (const f of stmt.from || []) {
    if (f?.join?.on) predicatesIn(f.join.on, preds);
    if (f?.type === 'table') {
      const name = f.name?.name;
      if (!name) continue;
      if (ctes.has(name)) {
        if (seen.has(name)) continue;                       // a CTE contributes once
        seen.add(name);
        walk(ctes.get(name), ctes, preds, tables, seen, depth + 1);
      } else tables.add(String(name));
    } else if (f?.type === 'statement') walk(f.statement, ctes, preds, tables, seen, depth + 1);
    else if (f?.type === 'call') { /* a set-returning function contributes no rows we can check */ }
  }
}

export function scopeOf(sql: string): Scope {
  const empty: Scope = { parsed: false, effective: [], tables: new Set() };
  if (!sql || !/\bselect\b/i.test(sql)) return empty;
  let stmts: any[];
  try { stmts = parse(String(sql)); } catch { return empty; }
  const stmt = stmts?.[0];
  if (!stmt) return empty;
  const ctes = new Map<string, any>();
  let root = stmt;
  if (stmt.type === 'with') {
    for (const b of stmt.bind || []) if (b?.alias?.name) ctes.set(String(b.alias.name), b.statement);
    root = stmt.in;
  }
  const effective: Predicate[] = [];
  const tables = new Set<string>();
  walk(root, ctes, effective, tables, new Set());
  return { parsed: true, effective, tables };
}

/** Is this literal used to restrict the rows the answer is computed from? */
export const restrictsBy = (s: Scope, value: string): boolean =>
  s.effective.some((p) => p.values.some((v) => v.toLowerCase() === String(value).toLowerCase()));

/* ── WHAT THE QUERY WOULD ACTUALLY EXPOSE ────────────────────────────────────────────────────
 *
 * The validator's patient-level rule blocks any query that MENTIONS Visit, Bill, TestOrder,
 * PaymentTransaction and friends unless it contains an aggregate. That is a proxy, and a bad one
 * in both directions. A TestOrder row is a test name, a price, a date and a branch — no person in
 * it — so "what did this scan cost last time" is refused; meanwhile the rule would happily pass
 * SELECT "name", "phone" FROM "Patient" ... GROUP BY 1,2 HAVING count(*) > 0, because it contains
 * an aggregate.
 *
 * What leaks is the COLUMNS a query returns, not the tables it reads. So: resolve every column
 * reference to its table, and find the identifying ones that are used outside an aggregate. A
 * name inside count(DISTINCT ...) is a measurement. A name in the select list is a disclosure.
 *
 * Scanning is deliberately whole-statement rather than just the final projection: a CTE that
 * selects a phone number and passes it upward is the same disclosure one level down, and
 * over-approximating here costs a rejected query, while under-approximating costs a patient's
 * phone number. */

/** Columns that identify a person wherever they appear. */
const IDENT_ANY = /^(phone|phone_?number|mobile|whatsapp|email|aadhaar|aadhar|uhid|mrn|dob|date_?of_?birth|patient_?name|patient_?phone|patient_?id|patientId)$/i;
/** Columns that identify a person when they belong to a person-carrying table. */
const IDENT_ON_PERSON = /^(name|first_?name|last_?name|full_?name|address|city|pincode|guardian|attendant|relation|age|gender)$/i;
const PERSON_TABLES = /^(Patient|PatientIdentifier|PatientChangeLog|PatientAuthEvent)$/i;
const AGGS = /^(count|sum|avg|min|max|percentile_cont|percentile_disc|stddev|variance|array_agg|string_agg|bool_or|bool_and)$/i;

/** alias -> table, over every FROM/JOIN in the statement. Over-approximate on purpose. */
function aliasMap(node: any, out: Map<string, string>, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 20) return;
  for (const f of node.from || []) {
    if (f?.type === 'table' && f.name?.name) {
      out.set(String(f.name.alias || f.name.name).toLowerCase(), String(f.name.name));
      out.set(String(f.name.name).toLowerCase(), String(f.name.name));
    }
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) for (const x of v) aliasMap(x, out, depth + 1);
    else if (v && typeof v === 'object') aliasMap(v, out, depth + 1);
  }
}

/** Identifying columns referenced outside any aggregate. Empty means nothing personal escapes. */
export function exposedIdentifiers(sql: string): { parsed: boolean; exposed: string[] } {
  let stmts: any[];
  try { stmts = parse(String(sql)); } catch { return { parsed: false, exposed: [] }; }
  const root = stmts?.[0];
  if (!root) return { parsed: false, exposed: [] };
  const alias = new Map<string, string>();
  aliasMap(root, alias);
  const exposed = new Set<string>();

  /* Only what the query RETURNS. A patientId in a JOIN ON is a key, not a disclosure — it never
     reaches anyone. Every select list in the statement is scanned, CTEs included, because a
     column projected one level down and passed upward is the same disclosure. */
  const walkExpr = (n: any, inAgg: boolean, depth = 0): void => {
    if (!n || typeof n !== 'object' || depth > 30) return;
    const agg = inAgg || (n.type === 'call' && AGGS.test(String(n.function?.name || '')));
    if (n.type === 'ref' && n.name && !agg) {
      const col = String(n.name);
      const tbl = n.table?.name ? alias.get(String(n.table.name).toLowerCase()) : undefined;
      if (IDENT_ANY.test(col)) exposed.add(`${tbl || '?'}.${col}`);
      else if (tbl && PERSON_TABLES.test(tbl) && IDENT_ON_PERSON.test(col)) exposed.add(`${tbl}.${col}`);
      // an unqualified identifying column with a person table anywhere in the query
      else if (!n.table && IDENT_ON_PERSON.test(col) && [...alias.values()].some((t) => PERSON_TABLES.test(t)))
        exposed.add(`?.${col}`);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const x of v) walkExpr(x, agg, depth + 1);
      else if (v && typeof v === 'object') walkExpr(v, agg, depth + 1);
    }
  };
  const selectLists = (n: any, depth = 0): void => {
    if (!n || typeof n !== 'object' || depth > 20) return;
    if (Array.isArray(n.columns)) for (const c of n.columns) walkExpr(c?.expr ?? c, false);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const x of v) selectLists(x, depth + 1);
      else if (v && typeof v === 'object') selectLists(v, depth + 1);
    }
  };
  selectLists(root);
  return { parsed: true, exposed: [...exposed] };
}

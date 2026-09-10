/**
 * Pulse — intent router. A model call, not keyword matching: the regex version scored 15/24
 * on real owner phrasing (2/6 on Hinglish, 2/6 on trap words like "slow" and "growth");
 * this scores 24/24 for ~250 tokens.
 */
import { llmJson } from './llm';
export type Mode = 'STATUS' | 'DIAGNOSE' | 'DIAGNOSE_AUTO' | 'OUT_OF_SCOPE' | 'LADDER';
export interface Route { mode: Mode; metric: string | null; period: string; }

const ROUTER_SYS = `Classify one question from a diagnostic-centre owner into exactly one intent.

STATUS   — "how is the business doing" — overall health, NO single metric named.
DIAGNOSE — "why did X move" — asks for the CAUSE of a change in a number. This includes
           questions that ASSERT a fall ("why did we lose money last week", "loss kyun hua"),
           even when the fall may not have happened — the premise gets checked downstream.
SQL      — anything else the centre's OWN records can answer: a figure, a list, a ranking,
           a breakdown, a lookup, a comparison.
OUT_OF_SCOPE — answering would need data the centre does not hold: what competitors or other
           labs did, where a patient went instead, market share, why someone chose elsewhere.
           A query would return 0 rows and 0 is NOT evidence those things did not happen.
           Choose this rather than letting an empty result be reported as a fact about the world.
LADDER   — any question about PROFIT, MARGIN or "are we making money" ("profit kitna",
           "margin", "kya bacha"). Profit itself cannot be computed here, but the money that
           IS recorded can be walked down step by step, so this gets its own answer rather
           than a refusal.

Careful: words like down, slow, growth, higher, doing appear innocently in SQL questions.
"break down X by branch" is a table request (SQL), not a claim that X fell.
"which tests are slow moving" is a ranking (SQL). "how is our TAT" asks for a number (SQL).
A complaint wrapped around a specific operational metric is still SQL: "patients say reports are
late, how bad is it" wants the turnaround figure, not a business-health overview.
Questions may be in Hinglish.

If DIAGNOSE, also name the metric when one is clearly implied, from:
revenue, visits, test_orders, reports_finalized, net_billed, discount_total. Else null.
The owner's words for these:
  collection / collected / kitna aaya / paisa / kamai  -> revenue
  cases / footfall / patients aaye                      -> visits
  tests / investigations                                -> test_orders
  billing / billed                                      -> net_billed
  discount / chhoot                                     -> discount_total
  reports / report finalize                             -> reports_finalized
  "loss" / "nuksan" / "lost money" about a period       -> revenue
Return JSON {"intent":"STATUS|DIAGNOSE|SQL|OUT_OF_SCOPE|LADDER","metric":null}.`;

const METRIC_WORDS: Record<string, RegExp> = {
  revenue: /revenue|collect|money|earning|income|cash|turnover|sales|kamai|paisa/i, visits: /visit|footfall|case|patient volume|traffic/i,
  test_orders: /test|workload|order|throughput|investigation/i, reports_finalized: /report|finali[sz]/i, net_billed: /billed|billing/i, discount_total: /discount/i,
};
import { todayIST } from './db';
/** "last month" -> the previous calendar month as YYYY-MM; "this month" / default -> month-to-date. */
export function period(q: string): string {
  const s = q.toLowerCase();
  const m = s.match(/\b(20\d\d)-(\d\d)\b/); if (m) return m[0];
  if (/\b(last|previous|pichh?le|pichla)\s+(month|mahine|mahina)\b|\bmonth before\b/.test(s)) { const [Y, M] = todayIST().split('-').map(Number); const pm = M === 1 ? 12 : M - 1, py = M === 1 ? Y - 1 : Y; return `${py}-${String(pm).padStart(2, '0')}`; }
  if (/\bweek\b|hafte|hafta/.test(s)) return 'week';
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  for (let i = 0; i < 12; i++) if (new RegExp(`\\b${MONTHS[i]}|\\b${MONTHS[i].slice(0, 3)}\\b`).test(s)) { const [Y] = todayIST().split('-').map(Number); return `${Y}-${String(i + 1).padStart(2, '0')}`; }
  return 'month';
}

/** Regex fallback — only used if the model call fails. Known-weak. */
function routeRegex(q: string): Route | null {
  const s = q.toLowerCase().replace(/break\s*down|breakdown|drill\s*down/g, ' split ');
  const why = /\bwhy\b|what (happened|changed|caused)|reason|driving|behind|explain|kyun/i.test(s);
  const status = /how (is|are|was|were|s)\b|how('| a)re we|doing|going|performance|overview|summary|health|kaisa chal/i.test(s);
  const down = /\b(down|drop|fell|decline|lower|worse|slump|slow)\b/i.test(s), up = /\b(up|grew|growth|rose|increase|higher|better|spike)\b/i.test(s);
  if (!why && !status && !(down || up)) return null;
  let metric: string | null = null; for (const [m, re] of Object.entries(METRIC_WORDS)) if (re.test(s)) { metric = m; break; }
  return { mode: (why || down || up) && metric ? 'DIAGNOSE' : (why || down || up) ? 'DIAGNOSE_AUTO' : 'STATUS', metric, period: period(q) };
}

/** null means "SQL path". */
export async function routeIntent(q: string, knownEntity = false): Promise<Route | null> {
  try {
    const j = await llmJson<{ intent?: string; metric?: string | null }>(ROUTER_SYS, String(q), { maxTokens: 60, timeoutMs: 12_000 });
    const intent = String(j.intent || '').toUpperCase();
    if (intent === 'SQL') return null;
    // a question that names a doctor / branch / test we know is never out of scope
    if (intent === 'OUT_OF_SCOPE') return knownEntity ? null : { mode: 'OUT_OF_SCOPE', metric: null, period: period(q) };
    // the model over-applies LADDER to "how was last month"; profit needs a profit word
    if (intent === 'LADDER') return /profit|margin|making money|make money|nafa|munafa|bacha|kamaya|earn/i.test(q) ? { mode: 'LADDER', metric: null, period: period(q) } : { mode: 'STATUS', metric: null, period: period(q) };
    if (intent !== 'STATUS' && intent !== 'DIAGNOSE') return routeRegex(q);
    const metric = j.metric && j.metric in METRIC_WORDS ? j.metric : null;
    return { mode: intent === 'STATUS' ? 'STATUS' : (metric ? 'DIAGNOSE' : 'DIAGNOSE_AUTO'), metric, period: period(q) };
  } catch { return routeRegex(q); }
}

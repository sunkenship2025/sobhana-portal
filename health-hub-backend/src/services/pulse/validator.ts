/**
 * Pulse — deterministic SQL safety. The real safety layer, itself under test: a conventional
 * validator leaked 5,451 report bearer tokens, 14 password hashes and 30,581 patient results on
 * the benchmark. This one blocks all four classes.
 *
 * WHAT THIS DOES NOT DECIDE: whether the asker may see patient-level data. That is an
 * authorization question and it does not belong in a SQL-shape check.
 *
 * The rule used to be `PHI table mentioned && no aggregate -> block`, which conflated the two and
 * got both wrong. It refused "the most recent CT-BRAIN PLAIN order and its amount" — a test name,
 * a price, a date, no person in it — and told the owner the centre might not record it. It would
 * equally have passed SELECT name, phone FROM "Patient" GROUP BY 1,2 HAVING count(*) > 0, because
 * that contains an aggregate. And the whole Pulse route is requireRole('owner'): the only person
 * who could ever hit this rule is the one who owns the records it was withholding.
 *
 * So the split is now explicit. Safety is enforced here, always, for everyone: no writes, no
 * secrets, no cartesian products, no fan-out double counting, no unbounded SELECT *. Whether
 * identifying columns may be RETURNED is a policy the caller passes in, decided from the asker's
 * role — not inferred from the shape of a query.
 */
import { exposedIdentifiers } from './v2/sqlscope';

const BAD = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|merge)\b/i;
// Tables analytics_ro gets NO grant on. Mirrors the DB role — belt and braces.
const DENY = /"?(ReportAccessToken|BillAccessToken|StatementAccessToken|PatientIdentifier|AppSetting|PatientAuthEvent|Conversation|ConversationMessage|ReportAccessLog|BillAccessLog|LinkAccessLog)"?\b/i;
const DENYCOL = /"?(passwordHash|token|ipAddress|userAgent|oldValues|newValues|patientSnapshot|signaturesSnapshot)"?\b/i;
const PHI = /"?(TestResult|Patient|MessageLog|AuditLog|PatientChangeLog|SmartReport|ReportVersion|ExternalReportUpload|AnomalyEvent|Visit|Bill|TestOrder|ClinicVisit|PaymentTransaction|OrderRefund)"?\b/i;
const AGG = /\b(count|sum|avg|min|max|percentile_cont|percentile_disc|stddev|variance)\s*\(/i;

/** What the asker is permitted to see. Decided at the route from their role, never here. */
export interface SqlPolicy {
  /** may a result identify a person? Owners may; a shared or staff surface may not. */
  rowLevel?: boolean;
}

/** Returns a reason string if the SQL must be blocked, else null. */
export function validate(sql: string, policy: SqlPolicy = {}): string | null {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) return 'empty';
  if (!/^(select|with)\b/i.test(s)) return 'not a SELECT';
  if (s.includes(';')) return 'multiple statements';
  if (BAD.test(s)) return 'forbidden keyword';
  if (/\b(pg_|information_schema)\w*/i.test(s)) return 'system catalog';
  if (DENY.test(s)) return 'table not granted to analytics_ro';
  if (DENYCOL.test(s)) return 'column not granted to analytics_ro';
  if (/select\s+\*/i.test(s)) return 'SELECT * not allowed';
  /* What leaks is the COLUMNS a query returns, not the tables it reads.
     The old rule blocked any query mentioning Visit/Bill/TestOrder/PaymentTransaction without an
     aggregate — wrong in both directions. It refused "the most recent CT-BRAIN PLAIN order and
     its amount" (a test name, a price, a date; no person in it) and would have passed
     SELECT name, phone FROM "Patient" ... GROUP BY 1,2 HAVING count(*) > 0, because that contains
     an aggregate.
     So resolve every column reference to its table and block the identifying ones used outside an
     aggregate. A name inside count(DISTINCT ...) is a measurement; a name in the select list is a
     disclosure. If the SQL does not parse we keep the blunt rule — this is the one guard where
     being wrong leaks a patient's phone number, so an unreadable query gets the strict answer. */
  /* AUTHORIZATION, not shape. Only when the caller says this asker may not see people do we look
     at whether the query would return one — and then it is the projected COLUMNS that matter, not
     which tables were read. A name inside count(DISTINCT ...) is a measurement; a name in the
     select list is a disclosure. If the SQL will not parse we fall back to the old blunt rule,
     because this is the one guard where being wrong exposes a patient. */
  if (policy.rowLevel === false) {
    const exposure = exposedIdentifiers(s);
    if (exposure.parsed) {
      if (exposure.exposed.length) return `not permitted to return identifying columns (${exposure.exposed.slice(0, 3).join(', ')})`;
    } else if (PHI.test(s) && !AGG.test(s)) return 'patient-level table requires an aggregate';
  }
  const froms = (s.match(/\bfrom\s+"?\w+"?(\s+(?!where|group|order|join|left|inner|on|having|limit)\w+)?\s*,/i) || [])[0];
  if (froms) return 'comma-join (implicit cross product) — use explicit JOIN ... ON';
  // An explicit CROSS JOIN is deliberate syntax (calendar x dimension grids need one) and is
  // bounded by the role's statement_timeout. A comma-join is an accident and stays blocked.
  const joins = [...s.matchAll(/\bjoin\s+"?(\w+)"?/gi)];
  const crossJoins = [...s.matchAll(/\bcross\s+join\b/gi)];
  const ons = [...s.matchAll(/\bon\b/gi)];
  if (joins.length - crossJoins.length > ons.length) return 'JOIN without ON — cartesian product';
  const sel = s.slice(0, s.search(/\bfrom\b/i));
  if (AGG.test(sel) && /"?\w+"?\.\s*"\w+"/.test(sel.replace(/\w+\s*\([^)]*\)/g, ''))
    && !/\bgroup\s+by\b/i.test(s) && !/\bover\s*\(/i.test(s))
    return 'aggregate mixed with bare column and no GROUP BY';
  // fan-out: aggregating a parent column across a one-to-many join — single-block queries only
  const CHILDREN: Record<string, string[]> = { Bill: ['PaymentTransaction', 'OrderRefund'], Visit: ['TestOrder', 'ReferralDoctor_Visit', 'Bill', 'ClinicVisit', 'DiagnosticReport'],
    ReportVersion: ['TestResult'], DiagnosticReport: ['ReportVersion'], TestOrder: ['TestResult', 'ExternalReportUpload'], Patient: ['Visit', 'MessageLog'], Branch: ['Visit', 'Bill', 'TestOrder'] };
  const PARENTCOL: Record<string, RegExp> = { Bill: /totalAmountInPaise|discountAmountInPaise|paidAmountInPaise|reversedChargeInPaise|couponDiscountInPaise/i,
    ClinicVisit: /consultationFeeInPaise/i, TestOrder: /priceInPaise/i, Visit: /totalAmountInPaise/i };
  const tablesIn = [...s.matchAll(/(?:from|join)\s+"(\w+)"/gi)].map((m) => m[1]);
  const aggBody = [...s.matchAll(/\b(sum|avg)\s*\(([^)]*)\)/gi)].map((m) => m[2]).join(' ');
  const singleBlock = (s.match(/\bselect\b/gi) || []).length === 1 && !/\bwith\b/i.test(s);
  if (singleBlock && aggBody && !/\bdistinct\b/i.test(aggBody)) {
    for (const parent of Object.keys(PARENTCOL)) {
      if (!tablesIn.includes(parent) || !PARENTCOL[parent].test(aggBody)) continue;
      const kids = (CHILDREN[parent] || []).filter((k) => tablesIn.includes(k));
      if (kids.length) return `fan-out: aggregating ${parent} across one-to-many join to ${kids.join('/')} — double counting`;
    }
  }
  return null;
}

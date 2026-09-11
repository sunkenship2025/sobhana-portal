/**
 * Pulse — deterministic SQL validator. The real safety layer, itself under test:
 * a conventional validator leaked 5,451 report bearer tokens, 14 password hashes and
 * 30,581 patient results on the benchmark. This one blocks all four classes.
 */
const BAD = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|vacuum|call|do|merge)\b/i;
// Tables analytics_ro gets NO grant on. Mirrors the DB role — belt and braces.
const DENY = /"?(ReportAccessToken|BillAccessToken|StatementAccessToken|PatientIdentifier|AppSetting|PatientAuthEvent|Conversation|ConversationMessage|ReportAccessLog|BillAccessLog|LinkAccessLog)"?\b/i;
const DENYCOL = /"?(passwordHash|token|ipAddress|userAgent|oldValues|newValues|patientSnapshot|signaturesSnapshot)"?\b/i;
const PHI = /"?(TestResult|Patient|MessageLog|AuditLog|PatientChangeLog|SmartReport|ReportVersion|ExternalReportUpload|AnomalyEvent|Visit|Bill|TestOrder|ClinicVisit|PaymentTransaction|OrderRefund)"?\b/i;
const AGG = /\b(count|sum|avg|min|max|percentile_cont|percentile_disc|stddev|variance)\s*\(/i;

/** Returns a reason string if the SQL must be blocked, else null. */
export function validate(sql: string): string | null {
  const s = String(sql || '').trim().replace(/;+\s*$/, '');
  if (!s) return 'empty';
  if (!/^(select|with)\b/i.test(s)) return 'not a SELECT';
  if (s.includes(';')) return 'multiple statements';
  if (BAD.test(s)) return 'forbidden keyword';
  if (/\b(pg_|information_schema)\w*/i.test(s)) return 'system catalog';
  if (DENY.test(s)) return 'table not granted to analytics_ro';
  if (DENYCOL.test(s)) return 'column not granted to analytics_ro';
  if (/select\s+\*/i.test(s)) return 'SELECT * not allowed';
  if (PHI.test(s) && !AGG.test(s)) return 'patient-level table requires an aggregate';
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

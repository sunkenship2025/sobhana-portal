/**
 * Check: scoreDueCollection severity bands (no DB needed).
 * Run: npx tsx prisma/check-due-collection-anomaly.ts
 * Guards the money path that surfaces "Due collected" rows on the Audit &
 * Anomalies page — the real bug was a ₹2,000 cash due cleared 11 days late that
 * showed up NOWHERE. That exact case must land HIGH.
 */
import assert from "node:assert";
import { scoreDueCollection } from "../src/services/anomalyProjectorService";

const cases: Array<[string, number, string, number, string]> = [
  // [label, amountInPaise, paymentType, daysLate, expectedSeverity]
  ["D.INDIRA: ₹2,000 cash, 11d late (the bug)", 200000, "CASH", 11, "high"],
  ["routine ₹300 cash next day", 30000, "CASH", 1, "low"],
  ["₹300 cash same day (hours later)", 30000, "CASH", 0, "low"],
  ["₹2,000 online, next day", 200000, "ONLINE", 1, "medium"],
  ["₹500 online, 5d late", 50000, "ONLINE", 5, "medium"],
  ["₹5,000 cash, 30d late", 500000, "CASH", 30, "high"],
  ["₹300 online, 20d late", 30000, "ONLINE", 20, "medium"], // small + very late tops out at medium, not high
];

let pass = 0;
for (const [label, amt, type, days, expected] of cases) {
  const { score, severity } = scoreDueCollection(amt, type, days);
  assert.strictEqual(severity, expected, `${label}: got ${severity} (score ${score}), expected ${expected}`);
  console.log(`ok  ${severity.padEnd(6)} score=${score}  ${label}`);
  pass++;
}
console.log(`\n${pass}/${cases.length} passed`);

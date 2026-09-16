/**
 * Day sheet ⇄ drawer identity.
 *
 * ONE invariant, checked against real data: for any day D, the Cash + Online on
 * the sheet must equal the money whose transactionDate falls on D — no matter
 * when the bill was raised. That single equality catches both halves of the bug
 * this file was written for: a due back-dated onto its bill's day breaks it from
 * one side, a due that appears on no sheet breaks it from the other.
 *
 *   npx tsx day-sheet-check.ts
 */
import prisma from './src/lib/prisma';
import { getMoneyDaySheet } from './src/services/ownerMoneyService';

const IST = `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'`;

async function main() {
  // The days that actually exercise it: where money moved on a day other than
  // the one its bill was raised. Plus a few ordinary days as a control.
  const days = await prisma.$queryRawUnsafe<{ d: string; skewed: bigint }[]>(`
    SELECT (pt."transactionDate" ${IST})::date::text AS d,
           count(*) FILTER (WHERE (pt."transactionDate" ${IST})::date
                               <> (b."billedAt" ${IST})::date) AS skewed
    FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id = pt."billId"
    GROUP BY 1 ORDER BY 2 DESC, 1 DESC LIMIT 15`);

  let failed = 0;
  for (const { d, skewed } of days) {
    const [{ drawer }] = await prisma.$queryRawUnsafe<{ drawer: bigint }[]>(`
      SELECT COALESCE(SUM(CASE WHEN pt."transactionType"='REFUND'
                               THEN -pt."amountInPaise" ELSE pt."amountInPaise" END),0) AS drawer
      FROM "PaymentTransaction" pt
      WHERE (pt."transactionDate" ${IST})::date = '${d}'`);

    const sheet = await getMoneyDaySheet('custom', null, { startKey: d, endKey: d });
    const onSheet = sheet.totals.cashInPaise + sheet.totals.onlineInPaise;
    const ok = onSheet === Number(drawer);
    if (!ok) failed += 1;

    const carried = sheet.rows.filter((r) => r.dueFrom !== null).length;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${d}  sheet ₹${(onSheet / 100).toLocaleString('en-IN')}` +
        `  drawer ₹${(Number(drawer) / 100).toLocaleString('en-IN')}` +
        `  carried rows ${carried}  (skewed txns ${skewed})`,
    );
  }

  // Billing must NOT absorb carried rows: Net counts only bills raised that day.
  const probe = days[0]?.d;
  if (probe) {
    const sheet = await getMoneyDaySheet('custom', null, { startKey: probe, endKey: probe });
    const leaked = sheet.rows.filter((r) => r.dueFrom && (r.grossInPaise || r.netInPaise));
    if (leaked.length) {
      failed += 1;
      console.log(`FAIL ${probe}  ${leaked.length} carried row(s) carry billing amounts`);
    } else {
      console.log(`ok   ${probe}  carried rows contribute nothing to Gross/Net`);
    }
  }

  console.log(failed ? `\n${failed} FAILED` : '\nall clean');
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main();

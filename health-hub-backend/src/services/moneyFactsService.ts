/**
 * The money engine: every owner money figure, from one place.
 *
 * The dashboard and the Money page each used to load every bill, test and
 * payment of a window and add them up their own way — and drifted (the Money
 * page charged commission on cancelled tests; neither took the bill discount
 * off a referral commission the way the payout statement does). This asks the
 * database to add up instead, by IST day × branch × register, and both pages
 * build their numbers from these few hundred rows.
 *
 * Definitions (one each, used everywhere):
 *   gross        Bill.totalAmountInPaise, by billedAt
 *   discount     counter discount + offer code (two Bill columns, one discount)
 *   cancelled    Bill.reversedChargeInPaise (charges voided after billing)
 *   commission   what each live test owes its referrer, exactly as the payout
 *                statement computes it (percentage of price minus the test's
 *                share of the bill's counter discount, floored at 0; fixed
 *                as frozen) + the partner's cut + clinic doctors' fees, by
 *                test/visit createdAt
 *   net to you   gross − discount − cancelled − commission
 *   collected    cash + online in, every refund out, by transactionDate
 *                (cheques are reported apart, as before)
 */
import { Prisma, VisitDomain } from '@prisma/client';
import prisma from '../lib/prisma';

export interface MoneyScope {
  start: Date;
  end: Date; // exclusive
  branchId: string | null;
  domain: VisitDomain | null; // null = both registers
}

/** One IST day × branch × register. Every amount in paise. */
export interface DayFact {
  date: string; // YYYY-MM-DD, IST
  branchId: string;
  domain: VisitDomain;
  gross: number;
  counterDiscount: number;
  coupon: number;
  cancelled: number;
  bills: number;
  visits: number;
  referralCommission: number;
  partnerCut: number;
  clinicFees: number;
  clinicCommission: number;
  cash: number;
  online: number;
  cheque: number;
  refunds: number;
}

/** One IST day × branch × register × payout category: what tests were sold. */
export interface CategoryFact {
  date: string;
  branchId: string;
  domain: VisitDomain;
  category: string;
  reportable: boolean; // false = bill-only / external upload
  price: number;
  tests: number;
}

const IST_DAY = (col: Prisma.Sql) =>
  Prisma.sql`to_char(${col} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`;

const n = (v: unknown) => Number(v ?? 0);

/**
 * `priced`: every test of every visit touched in the window, with its share of the bill's
 * counter discount exactly as the payout statement allocates it (largest
 * remainder over non-replaced tests, by price), the commission it owes, and its active referrer. A test
 * added on another day still takes its part of the discount.
 */
function liveOrderShares(scope: MoneyScope): Prisma.Sql {
  const { start, end, branchId, domain } = scope;
  const branch = branchId ? Prisma.sql`AND t."branchId" = ${branchId}` : Prisma.empty;
  const reg = domain ? Prisma.sql`AND v.domain = ${domain}::"VisitDomain"` : Prisma.empty;
  return Prisma.sql`
      WITH touched AS (
        SELECT DISTINCT t."visitId" FROM "TestOrder" t
        WHERE t."createdAt" >= ${start} AND t."createdAt" < ${end} ${branch}
      ),
      o AS (
        SELECT t.id, t."visitId", t."branchId", v.domain, t."createdAt", t."cancelledAt", t."replacedAt",
               greatest(round(t."priceInPaise"), 0)::bigint AS p, t."priceInPaise" AS price,
               t."referralCommissionType"::text AS ty, t."referralCommissionPercentage" AS pct,
               t."referralCommissionAmountInPaise" AS amt, coalesce(t."partnerCutInPaise", 0) AS cut,
               least(greatest(coalesce(b."discountAmountInPaise", 0), 0), greatest(coalesce(b."totalAmountInPaise", 0), 0))::bigint AS disc,
               ref."referralDoctorId"
        FROM "TestOrder" t
        JOIN touched USING ("visitId")
        JOIN "Visit" v ON v.id = t."visitId"
        LEFT JOIN "Bill" b ON b."visitId" = t."visitId"
        LEFT JOIN LATERAL (
          SELECT rv."referralDoctorId" FROM "ReferralDoctor_Visit" rv
          WHERE rv."visitId" = t."visitId" AND rv."deletedAt" IS NULL
          ORDER BY rv."createdAt" LIMIT 1
        ) ref ON TRUE
        WHERE TRUE ${reg}
      ),
      live AS (
        SELECT o.*, (sum(p) OVER w)::bigint AS total, least(disc, (sum(p) OVER w)::bigint) AS d
        FROM o WHERE "replacedAt" IS NULL
        WINDOW w AS (PARTITION BY "visitId")
      ),
      floored AS (
        SELECT live.*, CASE WHEN total > 0 THEN (d * p) / total ELSE 0 END AS fl,
               CASE WHEN total > 0 THEN (d * p) % total ELSE 0 END AS rem
        FROM live
      ),
      shared AS (
        SELECT floored.*,
               fl + CASE WHEN total > 0 AND row_number() OVER (PARTITION BY "visitId" ORDER BY rem DESC, id)
                              <= d - sum(fl) OVER (PARTITION BY "visitId") THEN 1 ELSE 0 END AS share
        FROM floored
      ),
      priced AS (
        SELECT shared.*,
               CASE
                 WHEN ty = 'FIXED_AMOUNT' THEN greatest(0, round(coalesce(amt, 0)))
                 ELSE greatest(0, round((price * coalesce(pct, 0) / 100)::numeric) - share)
               END AS commission
        FROM shared
      )`;
}


export async function getMoneyFacts(scope: MoneyScope): Promise<{ days: DayFact[]; categories: CategoryFact[] }> {
  const { start, end, branchId, domain } = scope;
  const branch = (col: Prisma.Sql) => (branchId ? Prisma.sql`AND ${col} = ${branchId}` : Prisma.empty);
  const reg = domain ? Prisma.sql`AND v.domain = ${domain}::"VisitDomain"` : Prisma.empty;

  const [bills, visits, orders, clinic, payments, categories] = await Promise.all([
    prisma.$queryRaw<any[]>`
      SELECT ${IST_DAY(Prisma.sql`b."billedAt"`)} AS date, b."branchId", v.domain::text AS domain,
             sum(b."totalAmountInPaise") AS gross, sum(b."discountAmountInPaise") AS "counterDiscount",
             sum(b."couponDiscountInPaise") AS coupon, sum(b."reversedChargeInPaise") AS cancelled, count(*) AS bills
      FROM "Bill" b JOIN "Visit" v ON v.id = b."visitId"
      WHERE b."billedAt" >= ${start} AND b."billedAt" < ${end} ${branch(Prisma.sql`b."branchId"`)} ${reg}
      GROUP BY 1, 2, 3`,
    prisma.$queryRaw<any[]>`
      SELECT ${IST_DAY(Prisma.sql`v."createdAt"`)} AS date, v."branchId", v.domain::text AS domain, count(*) AS visits
      FROM "Visit" v
      WHERE v."createdAt" >= ${start} AND v."createdAt" < ${end} ${branch(Prisma.sql`v."branchId"`)} ${reg}
      GROUP BY 1, 2, 3`,
    // Referral commission per live test, as the statement derives it.
    domain === 'CLINIC'
      ? Promise.resolve([])
      : prisma.$queryRaw<any[]>`
      ${liveOrderShares(scope)}
      SELECT ${IST_DAY(Prisma.sql`"createdAt"`)} AS date, "branchId", domain::text AS domain,
             sum(commission) AS "referralCommission",
             sum(cut) AS "partnerCut"
      FROM priced
      WHERE "cancelledAt" IS NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
      GROUP BY 1, 2, 3`,
    domain === 'DIAGNOSTICS'
      ? Promise.resolve([])
      : prisma.$queryRaw<any[]>`
      SELECT ${IST_DAY(Prisma.sql`cv."createdAt"`)} AS date, v."branchId", v.domain::text AS domain,
             sum(cv."consultationFeeInPaise") AS "clinicFees",
             sum(CASE
                   WHEN d."commissionType" = 'PERCENTAGE' THEN round((cv."consultationFeeInPaise" * coalesce(d."commissionPercent", 0) / 100)::numeric)
                   WHEN d."commissionType" = 'FIXED_AMOUNT' THEN coalesce(d."commissionAmountInPaise", 0)
                   ELSE 0
                 END) AS "clinicCommission"
      FROM "ClinicVisit" cv JOIN "Visit" v ON v.id = cv."visitId" JOIN "ClinicDoctor" d ON d.id = cv."clinicDoctorId"
      WHERE cv."createdAt" >= ${start} AND cv."createdAt" < ${end} ${branch(Prisma.sql`v."branchId"`)} ${reg}
      GROUP BY 1, 2, 3`,
    prisma.$queryRaw<any[]>`
      SELECT ${IST_DAY(Prisma.sql`pt."transactionDate"`)} AS date, b."branchId", v.domain::text AS domain,
             sum(CASE WHEN pt."transactionType" = 'PAYMENT' AND pt."paymentType" = 'CASH' THEN pt."amountInPaise" ELSE 0 END) AS cash,
             sum(CASE WHEN pt."transactionType" = 'PAYMENT' AND pt."paymentType" = 'ONLINE' THEN pt."amountInPaise" ELSE 0 END) AS online,
             sum(CASE WHEN pt."transactionType" = 'PAYMENT' AND pt."paymentType" = 'CHEQUE' THEN pt."amountInPaise" ELSE 0 END) AS cheque,
             sum(CASE WHEN pt."transactionType" = 'REFUND' THEN pt."amountInPaise" ELSE 0 END) AS refunds
      FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id = pt."billId" JOIN "Visit" v ON v.id = b."visitId"
      WHERE pt."transactionDate" >= ${start} AND pt."transactionDate" < ${end} ${branch(Prisma.sql`b."branchId"`)} ${reg}
      GROUP BY 1, 2, 3`,
    // "Upload instead" orders were SOLD as reportable — keep them there.
    domain === 'CLINIC'
      ? Promise.resolve([])
      : prisma.$queryRaw<any[]>`
      SELECT ${IST_DAY(Prisma.sql`t."createdAt"`)} AS date, t."branchId", v.domain::text AS domain,
             coalesce(nullif(trim(t."payoutCategorySnapshot"), ''), 'Uncategorised') AS category,
             (t."workflowMode" = 'REPORTABLE' OR t."uploadInsteadAt" IS NOT NULL) AS reportable,
             sum(t."priceInPaise") AS price, count(*) AS tests
      FROM "TestOrder" t JOIN "Visit" v ON v.id = t."visitId"
      WHERE t."createdAt" >= ${start} AND t."createdAt" < ${end} AND t."cancelledAt" IS NULL
            ${branch(Prisma.sql`t."branchId"`)} ${reg}
      GROUP BY 1, 2, 3, 4, 5`,
  ]);

  const days = new Map<string, DayFact>();
  const at = (r: any): DayFact => {
    const k = `${r.date}|${r.branchId}|${r.domain}`;
    let f = days.get(k);
    if (!f) {
      f = {
        date: r.date, branchId: r.branchId, domain: r.domain,
        gross: 0, counterDiscount: 0, coupon: 0, cancelled: 0, bills: 0, visits: 0,
        referralCommission: 0, partnerCut: 0, clinicFees: 0, clinicCommission: 0,
        cash: 0, online: 0, cheque: 0, refunds: 0,
      };
      days.set(k, f);
    }
    return f;
  };
  for (const r of bills) Object.assign(at(r), { gross: n(r.gross), counterDiscount: n(r.counterDiscount), coupon: n(r.coupon), cancelled: n(r.cancelled), bills: n(r.bills) });
  for (const r of visits) at(r).visits = n(r.visits);
  for (const r of orders) Object.assign(at(r), { referralCommission: n(r.referralCommission), partnerCut: n(r.partnerCut) });
  for (const r of clinic) Object.assign(at(r), { clinicFees: n(r.clinicFees), clinicCommission: n(r.clinicCommission) });
  for (const r of payments) Object.assign(at(r), { cash: n(r.cash), online: n(r.online), cheque: n(r.cheque), refunds: n(r.refunds) });

  return {
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    categories: categories.map((r) => ({
      date: r.date, branchId: r.branchId, domain: r.domain, category: r.category,
      reportable: Boolean(r.reportable), price: n(r.price), tests: n(r.tests),
    })),
  };
}

export interface MoneyTotals {
  gross: number;
  discount: number;
  coupon: number;
  cancelled: number;
  commission: number;
  net: number;
  bills: number;
  visits: number;
  cash: number;
  online: number;
  cheque: number;
  refunds: number;
  netCollected: number;
  clinicFees: number;
}

/** Add up any slice of day facts into the figures the pages show. */
export function totalsOf(facts: DayFact[]): MoneyTotals {
  const t = facts.reduce(
    (a, f) => {
      a.gross += f.gross;
      a.discount += f.counterDiscount + f.coupon;
      a.coupon += f.coupon;
      a.cancelled += f.cancelled;
      a.commission += f.referralCommission + f.partnerCut + f.clinicCommission;
      a.bills += f.bills;
      a.visits += f.visits;
      a.cash += f.cash;
      a.online += f.online;
      a.cheque += f.cheque;
      a.refunds += f.refunds;
      a.clinicFees += f.clinicFees;
      return a;
    },
    { gross: 0, discount: 0, coupon: 0, cancelled: 0, commission: 0, net: 0, bills: 0, visits: 0, cash: 0, online: 0, cheque: 0, refunds: 0, netCollected: 0, clinicFees: 0 },
  );
  t.net = t.gross - t.discount - t.cancelled - t.commission;
  t.netCollected = t.cash + t.online - t.refunds;
  return t;
}

export interface ReferrerFact {
  referralDoctorId: string;
  name: string;
  visits: number;
  billed: number; // live tests' price
  commission: number; // as the statement computes it
  priorVisits: number;
  priorBilled: number;
}

/**
 * Per referring doctor: this window vs the one before it (split at `splitAt`),
 * by test date. Commission follows the statement, from the same `priced` rows
 * the engine sums.
 */
export async function getReferrerFacts(scope: MoneyScope, splitAt: Date): Promise<ReferrerFact[]> {
  if (scope.domain === 'CLINIC') return [];
  const rows = await prisma.$queryRaw<any[]>`
    ${liveOrderShares(scope)}
    SELECT p."referralDoctorId", rd.name,
           count(DISTINCT p."visitId") FILTER (WHERE p."createdAt" >= ${splitAt}) AS visits,
           sum(p.price) FILTER (WHERE p."createdAt" >= ${splitAt}) AS billed,
           sum(p.commission) FILTER (WHERE p."createdAt" >= ${splitAt}) AS commission,
           count(DISTINCT p."visitId") FILTER (WHERE p."createdAt" < ${splitAt}) AS "priorVisits",
           sum(p.price) FILTER (WHERE p."createdAt" < ${splitAt}) AS "priorBilled"
    FROM priced p JOIN "ReferralDoctor" rd ON rd.id = p."referralDoctorId"
    WHERE p."cancelledAt" IS NULL AND p."createdAt" >= ${scope.start} AND p."createdAt" < ${scope.end}
    GROUP BY 1, 2`;
  return rows.map((r) => ({
    referralDoctorId: r.referralDoctorId,
    name: r.name,
    visits: n(r.visits),
    billed: n(r.billed),
    commission: n(r.commission),
    priorVisits: n(r.priorVisits),
    priorBilled: n(r.priorBilled),
  }));
}

export type BusinessSource = 'referred' | 'walkin' | 'partner' | 'clinic';
export interface SourceFact {
  source: BusinessSource;
  visits: number;
  gross: number;
  priorVisits: number;
  priorGross: number;
}

/**
 * Where billing came from, by bill date: a partner's patient (any test routed
 * through a partner), a doctor's referral, a walk-in, or a clinic consultation.
 */
export async function getSourceFacts(scope: MoneyScope, splitAt: Date): Promise<SourceFact[]> {
  const { start, end, branchId, domain } = scope;
  const rows = await prisma.$queryRaw<any[]>`
    SELECT CASE
             WHEN v.domain = 'CLINIC' THEN 'clinic'
             WHEN EXISTS (SELECT 1 FROM "TestOrder" t WHERE t."visitId" = v.id AND t."partnerId" IS NOT NULL) THEN 'partner'
             WHEN EXISTS (SELECT 1 FROM "ReferralDoctor_Visit" rv WHERE rv."visitId" = v.id AND rv."deletedAt" IS NULL) THEN 'referred'
             ELSE 'walkin'
           END AS source,
           count(*) FILTER (WHERE b."billedAt" >= ${splitAt}) AS visits,
           sum(b."totalAmountInPaise") FILTER (WHERE b."billedAt" >= ${splitAt}) AS gross,
           count(*) FILTER (WHERE b."billedAt" < ${splitAt}) AS "priorVisits",
           sum(b."totalAmountInPaise") FILTER (WHERE b."billedAt" < ${splitAt}) AS "priorGross"
    FROM "Bill" b JOIN "Visit" v ON v.id = b."visitId"
    WHERE b."billedAt" >= ${start} AND b."billedAt" < ${end}
          ${branchId ? Prisma.sql`AND b."branchId" = ${branchId}` : Prisma.empty}
          ${domain ? Prisma.sql`AND v.domain = ${domain}::"VisitDomain"` : Prisma.empty}
    GROUP BY 1`;
  return rows.map((r) => ({
    source: r.source,
    visits: n(r.visits),
    gross: n(r.gross),
    priorVisits: n(r.priorVisits),
    priorGross: n(r.priorGross),
  }));
}

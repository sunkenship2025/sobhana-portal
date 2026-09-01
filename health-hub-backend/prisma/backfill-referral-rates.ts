/**
 * One-time backfill: re-price ALL historical referral orders (Balanagar + Chintal,
 * all time) against the NEW per-branch rate cards + current panel/product tags,
 * overwriting each order's frozen commission snapshot + payout category. Statements,
 * Excels and the Pay-Run re-derive live from these order snapshots, so once this
 * runs they reflect the new numbers (the discount rule is applied at derive time,
 * unchanged).
 *
 * PREREQUISITE: run the panel/product tagging first (tag-finer-panels.sql) so
 * Tiffa / 2D Echo / Dental orders resolve to their finer category here.
 *
 * SAFETY: dry-run by default (writes nothing, prints a per-doctor before→after
 * report). Pass --commit to apply. Neon PITR is your undo.
 *
 *   npx tsx prisma/backfill-referral-rates.ts            # dry run
 *   npx tsx prisma/backfill-referral-rates.ts --commit   # apply
 */
import { PrismaClient, DiagnosticWorkflowMode, ReferralPayoutType } from '@prisma/client';
import { categorize } from '../src/services/payoutCategorize';
import { computeCommissionInPaise, distributeFixedAmountInPaise } from '../src/services/referralPayoutService';
import { derivePayout } from '../src/services/payoutService';

// Use the DIRECT (non-pooler) connection — stabler for a long batch job than the
// serverless pooler, which drops long-lived connections (P1017).
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL } },
});
const COMMIT = process.argv.includes('--commit');

// Retry a unit of work through transient Neon disconnects (P1017/P1001/reset).
async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const transient =
        e?.code === 'P1017' ||
        e?.code === 'P1001' ||
        /closed the connection|ECONNRESET|terminating|Timed out/i.test(e?.message ?? '');
      if (!transient || attempt >= tries) throw e;
      console.warn(`  ${label}: ${e?.code ?? 'conn error'} — retry ${attempt}/${tries} in ${attempt}s`);
      await new Promise((r) => setTimeout(r, attempt * 1000));
      try { await prisma.$disconnect(); await prisma.$connect(); } catch { /* reconnect best-effort */ }
    }
  }
}

const BRANCHES: Record<string, string> = {
  'cmm508nd20003he8pu4quj87g': 'Balanagar',
  'cmm508ml30000he8phuwm3qxc': 'Chintal',
};
const BRANCH_IDS = Object.keys(BRANCHES);

type Rate = {
  commissionType: ReferralPayoutType;
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
};
const rupees = (p: number) => (p / 100).toFixed(0);

// Prefer a branch-specific row over the global (branchId null) one for a key.
function pickBranchFirst<T extends { branchId: string | null }>(rows: T[], branchId: string): T | undefined {
  return rows.find((r) => r.branchId === branchId) ?? rows.find((r) => r.branchId === null);
}

async function main() {
  console.log(`\n=== Referral backfill — ${COMMIT ? 'COMMIT (writing)' : 'DRY RUN (no writes)'} ===\n`);

  // ── Load the rate card + per-doctor rules (all scopes) ──
  const catRates = await prisma.referralCategoryRate.findMany({ where: { isActive: true } });
  const doctors = await prisma.referralDoctor.findMany({
    include: {
      categoryRules: { where: { isActive: true } },
      productRules: { where: { isActive: true } },
    },
  });
  const doctorById = new Map(doctors.map((d) => [d.id, d]));

  // Resolve a rate the same way billing does: doctor·product → doctor·category →
  // centre·category, branch beating global at each layer; else a zero rate.
  // `source` marks where it came from — a FIXED product rule is a per-product
  // TOTAL and must be distributed across that product's leaf orders (below),
  // never applied per leaf.
  type Resolved = { rate: Rate; source: 'product' | 'category' | 'branch' | 'zero' };
  const resolveRate = (doctorId: string, branchId: string, category: string, productId: string | null): Resolved => {
    const doc = doctorById.get(doctorId);
    if (doc && productId) {
      const dp = pickBranchFirst(doc.productRules.filter((r) => r.productId === productId), branchId);
      if (dp) return { rate: dp, source: 'product' };
    }
    if (doc) {
      const dc = pickBranchFirst(doc.categoryRules.filter((r) => r.category === category), branchId);
      if (dc) return { rate: dc, source: 'category' };
    }
    const bc = pickBranchFirst(catRates.filter((r) => r.category === category), branchId);
    if (bc) return { rate: bc, source: 'branch' };
    return { rate: { commissionType: 'PERCENTAGE', commissionPercent: 0, commissionAmountInPaise: null }, source: 'zero' };
  };

  const grossOf = (r: { commissionType: ReferralPayoutType; commissionPercent?: number | null; commissionAmountInPaise?: number | null }, priceInPaise: number) =>
    computeCommissionInPaise({
      priceInPaise,
      commissionType: r.commissionType,
      commissionPercentage: r.commissionPercent ?? null,
      commissionAmountInPaise: r.commissionAmountInPaise ?? null,
    });

  // ── Load every referred visit for the two branches, all time ──
  const visits = await prisma.visit.findMany({
    where: {
      domain: 'DIAGNOSTICS',
      branchId: { in: BRANCH_IDS },
      referrals: { some: { deletedAt: null } },
    },
    include: {
      referrals: { where: { deletedAt: null }, select: { referralDoctorId: true } },
      testOrders: {
        include: {
          product: { select: { id: true, name: true, payoutCategory: true } },
          test: { select: { name: true } },
        },
      },
      report: { include: { versions: { where: { status: 'FINALIZED' }, take: 1 } } },
    },
  });

  type Agg = { name: string; changed: number; outsourced: number; oldGross: number; newGross: number };
  const perDoctor = new Map<string, Agg>();
  const updates: { id: string; type: ReferralPayoutType; pct: number | null; amt: number | null; cat: string }[] = [];
  const affected = new Set<string>(); // `${doctorId}|${branchId}`
  let scanned = 0;

  for (const visit of visits) {
    const doctorId = visit.referrals[0]?.referralDoctorId;
    if (!doctorId) continue;
    const branchId = visit.branchId;
    const finalized = Boolean(visit.report?.versions[0]?.finalizedAt);

    // Pass 1 — resolve category + rate + source for each live order.
    const live = visit.testOrders.filter((o) => !o.cancelledAt);
    scanned += live.length;
    const resolved = live.map((o) => {
      const newCat =
        o.product?.payoutCategory?.trim() ||
        o.payoutCategorySnapshot?.trim() ||
        categorize({ productName: o.product?.name, testName: o.test?.name });
      return { o, newCat, ...resolveRate(doctorId, branchId, newCat, o.productId ?? null) };
    });

    // Pass 2 — a FIXED product rule is one total for the whole product; split it
    // across that product's leaf orders in this visit (weighted by price), like
    // billing does. Without this, a ₹50 CBP rule lands ₹50 on each of ~13 leaves.
    const distributed = new Map<string, number>();
    const groups = new Map<string, { amount: number; orders: { id: string; price: number }[] }>();
    for (const e of resolved) {
      if (e.source === 'product' && e.rate.commissionType === 'FIXED_AMOUNT' && e.o.productId) {
        const g = groups.get(e.o.productId) ?? { amount: e.rate.commissionAmountInPaise ?? 0, orders: [] };
        g.orders.push({ id: e.o.id, price: e.o.priceInPaise });
        groups.set(e.o.productId, g);
      }
    }
    for (const g of groups.values()) {
      const shares = distributeFixedAmountInPaise(g.amount, g.orders.map((x) => x.price));
      g.orders.forEach((x, i) => distributed.set(x.id, shares[i]));
    }

    // Pass 3 — finalize each order.
    for (const e of resolved) {
      const o = e.o;
      const newType = e.rate.commissionType;
      const newPct = newType === 'PERCENTAGE' ? e.rate.commissionPercent ?? 0 : null;
      const newAmt =
        newType === 'FIXED_AMOUNT'
          ? distributed.has(o.id) ? distributed.get(o.id)! : e.rate.commissionAmountInPaise ?? 0
          : null;

      const changedRate =
        o.referralCommissionType !== newType ||
        (o.referralCommissionPercentage ?? null) !== newPct ||
        (o.referralCommissionAmountInPaise ?? null) !== newAmt;
      const changedCat = (o.payoutCategorySnapshot ?? null) !== e.newCat;
      if (!changedRate && !changedCat) continue;

      updates.push({ id: o.id, type: newType, pct: newPct, amt: newAmt, cat: e.newCat });
      affected.add(`${doctorId}|${branchId}`);

      // Report totals over PAYABLE orders only (matches what statements show).
      const payable = finalized || o.workflowMode === DiagnosticWorkflowMode.BILL_ONLY || o.noReportAt != null;
      if (!payable) continue;
      const a = perDoctor.get(doctorId) ?? { name: doctorById.get(doctorId)?.name ?? doctorId, changed: 0, outsourced: 0, oldGross: 0, newGross: 0 };
      a.changed++;
      if (o.externalLabId) a.outsourced++;
      a.oldGross += grossOf({ commissionType: o.referralCommissionType, commissionPercent: o.referralCommissionPercentage, commissionAmountInPaise: o.referralCommissionAmountInPaise }, o.priceInPaise);
      a.newGross += newType === 'FIXED_AMOUNT' ? (newAmt ?? 0) : Math.round((o.priceInPaise * (newPct ?? 0)) / 100);
      perDoctor.set(doctorId, a);
    }
  }

  // ── Report ──
  const rows = [...perDoctor.values()].sort((a, b) => (b.newGross - b.oldGross) - (a.newGross - a.oldGross));
  console.log(`Scanned ${scanned} referred orders · ${updates.length} order snapshots will change · ${rows.length} doctors affected\n`);
  console.log('Per doctor (gross commission, pre-discount estimate — exact figures show on the statements after commit):');
  console.log('  doctor'.padEnd(34), 'chg'.padStart(5), 'old ₹'.padStart(10), 'new ₹'.padStart(10), 'Δ ₹'.padStart(10), '  note');
  let tOld = 0, tNew = 0;
  for (const r of rows) {
    tOld += r.oldGross; tNew += r.newGross;
    console.log(
      ('  ' + r.name).padEnd(34),
      String(r.changed).padStart(5),
      rupees(r.oldGross).padStart(10),
      rupees(r.newGross).padStart(10),
      rupees(r.newGross - r.oldGross).padStart(10),
      r.outsourced ? `  ${r.outsourced} outsourced (was lab-reduced)` : '',
    );
  }
  console.log('  ' + '─'.repeat(70));
  console.log('  TOTAL'.padEnd(34), ''.padStart(5), rupees(tOld).padStart(10), rupees(tNew).padStart(10), rupees(tNew - tOld).padStart(10));

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit to apply the ${updates.length} snapshot changes.\n`);
    await prisma.$disconnect();
    return;
  }

  // ── Apply ──
  console.log(`\nApplying ${updates.length} snapshot updates…`);
  const CHUNK = 200;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await withRetry(
      () =>
        prisma.$transaction(
          slice.map((u) =>
            prisma.testOrder.update({
              where: { id: u.id },
              data: {
                referralCommissionType: u.type,
                referralCommissionPercentage: u.pct,
                referralCommissionAmountInPaise: u.amt,
                payoutCategorySnapshot: u.cat,
              },
            }),
          ),
        ),
      `chunk@${i}`,
    );
    console.log(`  …${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  // Refresh any saved Pay-Run ledger rows so stored sums aren't stale (statements
  // re-derive live, so this is only for already-saved runs). Best-effort.
  const ledgers = await prisma.doctorPayoutLedger.findMany({
    where: { doctorType: 'REFERRAL', branchId: { in: BRANCH_IDS }, deletedAt: null },
    select: { referralDoctorId: true, branchId: true, periodStartDate: true, periodEndDate: true },
  });
  console.log(`\nRe-deriving ${ledgers.length} saved payout runs…`);
  for (const l of ledgers) {
    if (!l.referralDoctorId) continue;
    try {
      await withRetry(
        () => derivePayout('REFERRAL', l.referralDoctorId!, l.branchId, l.periodStartDate, l.periodEndDate),
        `derive ${l.referralDoctorId}`,
      );
    } catch (e) {
      console.warn(`  re-derive failed for ${l.referralDoctorId} ${l.branchId}:`, (e as Error).message);
    }
  }

  console.log('\nDone. Open a doctor statement / Excel to confirm the new numbers.\n');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});

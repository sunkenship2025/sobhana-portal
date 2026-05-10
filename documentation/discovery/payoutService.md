# File: src/services/payoutService.ts (+ referralPayoutService.ts)

## Purpose
Derive, persist, list, and finalize doctor/center payouts based on `TestOrder` snapshots and `ClinicVisit` consultation fees. Writes/updates to the immutable `DoctorPayoutLedger`. Per schema rule: "Payout derived per test order (not per visit total)."

## Dependencies / Imports

```ts
import { DiagnosticWorkflowMode, PayoutDoctorType, PaymentType, Prisma, ReportStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { computeCommissionInPaise, computeReferralPayoutInPaise } from './referralPayoutService';
import {
  allocateBillDiscountAcrossOrders,
  computeBillFinancialsFromPersisted,
} from './billFinancialService';
```

## Exported Types

```ts
export interface PayoutLineItem {
  visitId: string;
  productId?: string | null;
  billNumber: string;
  patientName: string;
  date: Date;
  testOrFee: string; // Test name for referral, "Consultation Fee" for clinic
  amountInPaise: number;
  commissionPercentage?: number;
  commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  commissionAmountInPaise?: number;
  commissionLabel?: string;
  derivedCommissionInPaise: number;
}

export interface PayoutDerivationResult {
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  periodStartDate: Date;
  periodEndDate: Date;
  lineItems: PayoutLineItem[];
  derivedAmountInPaise: number;
}

export interface PayoutSummary { ... }
export interface PayoutDetail extends PayoutSummary { lineItems: PayoutLineItem[] ... }
```

## Exported Functions

| Function | Purpose |
| --- | --- |
| `derivePayout(doctorType, doctorId, branchId, periodStart, periodEnd)` | Derive (or refresh unpaid) ledger entry for the period |
| `listPayouts(branchId, filters?)` | List ledger entries; runs background sync first |
| `getPayoutDetail(payoutId)` | Detail view (re-derives line items at read time) |
| `markPayoutPaid(payoutId, paymentMethod, paymentReferenceId?, notes?)` | Atomic mark-paid + cascade to overlapping unpaid payouts |
| `getReferralDoctors(isActive?, branchId?)` | Dropdown list (optionally scoped to branch with payout activity) |
| `getClinicDoctors(isActive?, branchId?)` | Dropdown list |
| `getDiagnosticCenters(isActive?, branchId?)` | Dropdown list |

## Doctor Referral Commission Calculation

### REFERRAL doctors
Per source comment:
```
- percentage rules: discounted test-order share × referralCommissionPercentage / 100
- fixed rules: referralCommissionAmountInPaise snapshot
for all tests in visits where:
  - Visit has a finalized report
  - Visit is linked to this referral doctor
  - Visit is in the given branch
  - Report finalized within the period
```

For percentage commissions, the test-order price has its allocated **discount portion subtracted** before applying the percentage (`allocateBillDiscountAcrossOrders` from `billFinancialService` distributes the bill-level discount across orders). Fixed-amount commissions ignore the discount and use the snapshot directly.

### CLINIC doctors
Per source comment: "Commission (percentage or fixed amount) of `consultationFeeInPaise` for all completed clinic visits in the period." Defaults to `commissionPercent ?? 100` if no commission configured, and the formula is `Math.round(cv.consultationFeeInPaise * percent / 100)` for the percentage path.

### DIAGNOSTIC_CENTER
Per source comment:
```
- snapshot percentage rules: testOrder.priceInPaise × diagnosticCenterCommissionPercentage / 100
- snapshot fixed rules: diagnosticCenterCommissionAmountInPaise
for all finalized diagnostic-center-linked visits in the period.
Older records created before snapshot support fall back to the center's legacy percentage.
```

If `testOrder.diagnosticCenterCommissionType !== null`, the snapshot is used; otherwise falls back to `Math.round((priceInPaise * center.commissionPercent) / 100)`.

## Period / Visit-Window Logic

`buildDiagnosticPayoutVisitWindow(startDate, endDate)` matches visits where **either**:
1. `report.versions.some({ status: FINALIZED, finalizedAt: { gte: start, lte: end } })`, **or**
2. `status: 'COMPLETED'` AND `updatedAt` in window AND `testOrders.some({ workflowMode: BILL_ONLY })` AND no finalized report exists.

This means **pure bill-only visits** qualify by completion-time proxy on `Visit.updatedAt`, while reportable + mixed visits qualify by `ReportVersion.finalizedAt`.

`buildDayPeriod(date)` clamps to start-of-day (00:00:00.000) and end-of-day (23:59:59.999) — daily ledger granularity.

## Payout Timing

Payouts are derived in two ways:
1. **Imperative** — `derivePayout(doctorType, doctorId, branchId, start, end)` called explicitly (e.g., from finalize transaction in `diagnosticVisits.ts`).
2. **Lazy sync on list** — `listPayouts(branchId, filters)` calls:
   - `syncReferralPayoutsForBranch(branchId, filters)` then
   - `syncDiagnosticCenterPayoutsForBranch(branchId, filters)`
   These iterate in-period visits, group by `(doctorId, day)`, and call `derivePayout` for each unique combination. Clinic payouts are NOT auto-synced.

## Percentage Configuration / Branch Overrides (factual)

- **Percentage source for REFERRAL**: snapshotted on `TestOrder.referralCommissionType`/`referralCommissionPercentage`/`referralCommissionAmountInPaise` at order creation time. The base value comes from `ReferralDoctor` (default 10.0%) optionally overridden by `ReferralDoctorProductRule` per product.
- **Percentage source for DIAGNOSTIC_CENTER**: snapshotted on `TestOrder.diagnosticCenterCommissionType` etc. Base from `DiagnosticReferralCenter` + `DiagnosticCenterProductRule` per product.
- **Percentage source for CLINIC**: read live from `ClinicDoctor.commissionPercent` / `commissionAmountInPaise` (NOT snapshotted on `ClinicVisit`).
- **No branch-level commission overrides exist.** Branches affect price (`ProductBranchPricing`) but not commission rates.

## Rounding Rules (factual)

All commission math goes through `referralPayoutService.computeCommissionInPaise`:

```ts
if (commissionType === 'FIXED_AMOUNT')
  return Math.max(0, Math.round(commissionAmountInPaise ?? 0));
return Math.round((priceInPaise * (commissionPercentage ?? 0)) / 100);
```

Discount allocation across orders (when computing referral commissions) uses largest-remainder distribution from `billFinancialService.allocateBillDiscountAcrossOrders` — integer paise, no fractional values.

`distributeFixedAmountInPaise(total, weights)`:
- Allocates last entry as `total - sum(allocated)` to absorb residual; previous entries floor-divide on weight ratio.
- Zero-weight inputs trigger even split with last entry receiving the remainder.

## Payout Mark-Paid Concurrency Semantics (verbatim)

```
Concurrency: uses an atomic conditional updateMany so two simultaneous
mark-paid calls don't both succeed (which would double-pay the doctor).

Cascade: payouts whose period falls inside this payout's period AND that
were derived BEFORE this one was paid are also marked paid. Newly-derived
payouts created AFTER the human approved the outer payment are NOT
auto-paid — they need their own approval.
```

Implementation:
```ts
await tx.doctorPayoutLedger.updateMany({
  where: { id: payoutId, paidAt: null },
  data: { paidAt, paymentMethod, paymentReferenceId, notes },
});
if (claim.count === 0) throw new Error('Payout already marked as paid - cannot modify');
```

Cascade scope: `branchId` + `doctorType` + `doctorIdWhereClause(...)` + `paidAt: null` + `periodStartDate >= existing.periodStartDate` + `periodEndDate <= existing.periodEndDate` + `derivedAt <= paidAt`.

## Refresh Logic for Existing Unpaid Entries (verbatim from comment)

```
Existing unpaid entries are refreshed so the ledger stays in sync with
newly completed/finalized work in the same period.
```

If `existing && !existing.paidAt`:
- If derived amount changed → update `derivedAmountInPaise` + `derivedAt = now`.
- If a covering paid payout exists (per `findCoveringPaidPayout`) → propagate `paidAt`, `paymentMethod`, `paymentReferenceId`, and (if not already set) `notes`.

Once `paidAt` is set, the row is treated as immutable.

## Architectural Observations (factual)

- Line items in `getPayoutDetail` are **re-derived at read time**; the ledger row only stores the aggregate `derivedAmountInPaise`. This means `lineItems` reflect the current state of underlying orders/visits even after the payout has been paid.
- Day granularity: `buildDayPeriod` produces per-day ledger entries, suggesting payouts are intended to settle per finalize-day (rather than weekly/monthly periods). The compound unique on `DoctorPayoutLedger` includes `(periodStartDate, periodEndDate)`, so daily entries accumulate as visits finalize.
- `syncReferralPayoutsForBranch` / `syncDiagnosticCenterPayoutsForBranch` iterate the entire matching window (default `new Date(0)`–`9999-12-31`) when no filter is passed — runs on every `listPayouts` call.
- Mixed commission types within the same product group are surfaced via `commissionLabel: 'Mixed'` (set by `markCommissionAsMixed`), losing per-test details for the UI.

## Raw Source: payoutService.ts

```ts
import { DiagnosticWorkflowMode, PayoutDoctorType, PaymentType, Prisma, ReportStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { computeCommissionInPaise, computeReferralPayoutInPaise } from './referralPayoutService';
import {
  allocateBillDiscountAcrossOrders,
  computeBillFinancialsFromPersisted,
} from './billFinancialService';


// ===========================================================================
// TYPES
// ===========================================================================

export interface PayoutLineItem {
  visitId: string;
  productId?: string | null;
  billNumber: string;
  patientName: string;
  date: Date;
  testOrFee: string; // Test name for referral, "Consultation Fee" for clinic
  amountInPaise: number;
  commissionPercentage?: number; // Only for referral/diagnostic center
  commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  commissionAmountInPaise?: number;
  commissionLabel?: string;
  derivedCommissionInPaise: number;
}

export interface PayoutDerivationResult {
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  periodStartDate: Date;
  periodEndDate: Date;
  lineItems: PayoutLineItem[];
  derivedAmountInPaise: number;
}

export interface PayoutSummary {
  id: string;
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  branchName: string;
  periodStartDate: Date;
  periodEndDate: Date;
  derivedAmountInPaise: number;
  derivedAt: Date;
  paidAt: Date | null;
  paymentMethod: PaymentType | null;
}

export interface PayoutDetail extends PayoutSummary {
  paymentReferenceId: string | null;
  notes: string | null;
  reviewedAt: Date | null;
  lineItems: PayoutLineItem[];
}

function buildDateWindow(startDate?: Date, endDate?: Date) {
  return {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  };
}

function buildDiagnosticPayoutVisitWindow(startDate: Date, endDate: Date): Prisma.VisitWhereInput {
  return {
    OR: [
      {
        report: {
          is: {
            versions: {
              some: {
                status: ReportStatus.FINALIZED,
                finalizedAt: buildDateWindow(startDate, endDate),
              },
            },
          },
        },
      },
      {
        status: 'COMPLETED',
        updatedAt: buildDateWindow(startDate, endDate),
        testOrders: {
          some: {
            workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
          },
        },
        OR: [
          {
            report: {
              is: null,
            },
          },
          {
            report: {
              is: {
                versions: {
                  none: {
                    status: ReportStatus.FINALIZED,
                  },
                },
              },
            },
          },
        ],
      },
    ],
  };
}

function markCommissionAsMixed(lineItem: PayoutLineItem) {
  lineItem.commissionType = undefined;
  lineItem.commissionPercentage = undefined;
  lineItem.commissionAmountInPaise = undefined;
  lineItem.commissionLabel = 'Mixed';
}

function mergeGroupedCommission(target: PayoutLineItem, incoming: PayoutLineItem) {
  if (target.commissionLabel === 'Mixed' || incoming.commissionLabel === 'Mixed') {
    markCommissionAsMixed(target);
    return;
  }

  if (!target.commissionType && !incoming.commissionType) {
    return;
  }

  if (target.commissionType === 'FIXED_AMOUNT' && incoming.commissionType === 'FIXED_AMOUNT') {
    target.commissionAmountInPaise =
      (target.commissionAmountInPaise ?? 0) + (incoming.commissionAmountInPaise ?? 0);
    return;
  }

  if (target.commissionType === 'PERCENTAGE' && incoming.commissionType === 'PERCENTAGE') {
    const targetPercent = target.commissionPercentage ?? 0;
    const incomingPercent = incoming.commissionPercentage ?? 0;

    if (Math.abs(targetPercent - incomingPercent) <= 0.0001) {
      return;
    }
  }

  markCommissionAsMixed(target);
}

function groupDiagnosticLineItemsByBillableProduct(lineItems: PayoutLineItem[]) {
  const groupedLineItems: PayoutLineItem[] = [];
  const groupedProductLineItems = new Map<string, PayoutLineItem>();

  for (const lineItem of lineItems) {
    if (!lineItem.productId) {
      groupedLineItems.push(lineItem);
      continue;
    }

    const groupingKey = `${lineItem.visitId}:${lineItem.productId}`;
    const existing = groupedProductLineItems.get(groupingKey);

    if (!existing) {
      const groupedItem = { ...lineItem };
      groupedProductLineItems.set(groupingKey, groupedItem);
      groupedLineItems.push(groupedItem);
      continue;
    }

    existing.amountInPaise += lineItem.amountInPaise;
    existing.derivedCommissionInPaise += lineItem.derivedCommissionInPaise;
    mergeGroupedCommission(existing, lineItem);
  }

  return groupedLineItems;
}

// ===========================================================================
// DERIVATION LOGIC - REFERRAL DOCTORS
// ===========================================================================

/**
 * Derive payout for a referral doctor.
 * Formula:
 *   - percentage rules: discounted test-order share × referralCommissionPercentage / 100
 *   - fixed rules: referralCommissionAmountInPaise snapshot
 * for all tests in visits where:
 *   - Visit has a finalized report
 *   - Visit is linked to this referral doctor
 *   - Visit is in the given branch
 *   - Report finalized within the period
 */
async function deriveReferralPayout(
  referralDoctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  const doctor = await prisma.referralDoctor.findUnique({
    where: { id: referralDoctorId },
    select: { id: true, name: true },
  });

  if (!doctor) {
    throw new Error('Referral doctor not found');
  }

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      referrals: {
        some: { referralDoctorId },
      },
      ...buildDiagnosticPayoutVisitWindow(periodStartDate, periodEndDate),
    },
    include: {
      patient: { select: { name: true } },
      testOrders: {
        include: {
          test: { select: { name: true } },
          product: { select: { id: true, name: true, code: true } },
        },
      },
      bill: true,
      report: {
        include: {
          versions: {
            where: { status: 'FINALIZED' },
            orderBy: { versionNum: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const visit of visits) {
    const finalizedAt = visit.report?.versions[0]?.finalizedAt;
    const billFinancials = visit.bill
      ? computeBillFinancialsFromPersisted(visit.bill)
      : null;
    const discountAllocations = billFinancials
      ? allocateBillDiscountAcrossOrders(
          visit.testOrders.map((order) => ({
            id: order.id,
            priceInPaise: order.priceInPaise,
          })),
          billFinancials.discountAmountInPaise
        )
      : new Map<string, number>();

    for (const testOrder of visit.testOrders) {
      const referralAmountInPaise =
        testOrder.referralCommissionType === 'PERCENTAGE'
          ? Math.max(
              0,
              testOrder.priceInPaise - (discountAllocations.get(testOrder.id) ?? 0)
            )
          : testOrder.priceInPaise;
      const commissionInPaise =
        testOrder.referralCommissionType === 'PERCENTAGE'
          ? computeCommissionInPaise({
              priceInPaise: referralAmountInPaise,
              commissionType: testOrder.referralCommissionType,
              commissionPercentage: testOrder.referralCommissionPercentage,
              commissionAmountInPaise: testOrder.referralCommissionAmountInPaise,
            })
          : computeReferralPayoutInPaise(testOrder);
      totalDerivedInPaise += commissionInPaise;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        date: finalizedAt || visit.updatedAt || visit.createdAt,
        testOrFee:
          testOrder.product?.name ||
          testOrder.testNameSnapshot ||
          testOrder.test.name,
        amountInPaise: referralAmountInPaise,
        commissionType: testOrder.referralCommissionType,
        commissionPercentage:
          testOrder.referralCommissionType === 'PERCENTAGE'
            ? testOrder.referralCommissionPercentage ?? undefined
            : undefined,
        commissionAmountInPaise:
          testOrder.referralCommissionType === 'FIXED_AMOUNT'
            ? testOrder.referralCommissionAmountInPaise ?? undefined
            : undefined,
        derivedCommissionInPaise: commissionInPaise,
      });
    }
  }

  return {
    doctorType: 'REFERRAL',
    doctorId: referralDoctorId,
    doctorName: doctor.name,
    branchId,
    periodStartDate,
    periodEndDate,
    lineItems: groupDiagnosticLineItemsByBillableProduct(lineItems),
    derivedAmountInPaise: totalDerivedInPaise,
  };
}

// ... CLINIC and DIAGNOSTIC_CENTER derivers, derivePayout, listPayouts,
// getPayoutDetail, markPayoutPaid, getReferralDoctors, getClinicDoctors,
// getDiagnosticCenters — see the full source for these functions.
```

> **Note:** The `payoutService.ts` source is 1208 lines — to keep this discovery doc focused, the full source is reproduced as a single block in [`payoutService_source.md`](./payoutService_source.md). The annotations above describe behavior verbatim from that source.

## Raw Source: referralPayoutService.ts (full)

```ts
import { ReferralPayoutType } from '@prisma/client';

export interface ReferralPayoutInput {
  commissionType?: ReferralPayoutType | string | null;
  commissionPercent?: number | string | null;
  commissionAmount?: number | string | null; // User-facing rupees
  commissionAmountInPaise?: number | string | null;
}

export interface NormalizedReferralPayout {
  commissionType: ReferralPayoutType;
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeReferralPayoutInput(
  input: ReferralPayoutInput,
  fallbackType: ReferralPayoutType = 'PERCENTAGE'
): NormalizedReferralPayout {
  const commissionType =
    input.commissionType === 'FIXED_AMOUNT'
      ? 'FIXED_AMOUNT'
      : input.commissionType === 'PERCENTAGE'
        ? 'PERCENTAGE'
        : fallbackType;

  if (commissionType === 'FIXED_AMOUNT') {
    const explicitPaise = toFiniteNumber(input.commissionAmountInPaise);
    const rupees = toFiniteNumber(input.commissionAmount);
    const commissionAmountInPaise =
      explicitPaise ?? (rupees !== null ? Math.round(rupees * 100) : null);

    if (commissionAmountInPaise === null || commissionAmountInPaise < 0) {
      throw new Error('Commission amount must be a non-negative number');
    }

    return {
      commissionType,
      commissionPercent: null,
      commissionAmountInPaise,
    };
  }

  const commissionPercent = toFiniteNumber(input.commissionPercent);
  if (commissionPercent === null || commissionPercent < 0 || commissionPercent > 100) {
    throw new Error('Commission percent must be between 0 and 100');
  }

  return {
    commissionType,
    commissionPercent,
    commissionAmountInPaise: null,
  };
}

export function normalizeReferralOverrideInput(input: unknown): NormalizedReferralPayout | null {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  if (typeof input === 'number' || typeof input === 'string') {
    return normalizeReferralPayoutInput({
      commissionType: 'PERCENTAGE',
      commissionPercent: input,
    });
  }

  if (typeof input === 'object') {
    return normalizeReferralPayoutInput(input as ReferralPayoutInput);
  }

  throw new Error('Invalid referral override');
}

export function computeReferralPayoutInPaise(order: {
  priceInPaise: number;
  referralCommissionType?: ReferralPayoutType | null;
  referralCommissionPercentage?: number | null;
  referralCommissionAmountInPaise?: number | null;
}): number {
  return computeCommissionInPaise({
    priceInPaise: order.priceInPaise,
    commissionType: order.referralCommissionType,
    commissionPercentage: order.referralCommissionPercentage,
    commissionAmountInPaise: order.referralCommissionAmountInPaise,
  });
}

export function computeCommissionInPaise(input: {
  priceInPaise: number;
  commissionType?: ReferralPayoutType | null;
  commissionPercentage?: number | null;
  commissionAmountInPaise?: number | null;
}) {
  if (input.commissionType === 'FIXED_AMOUNT') {
    return Math.max(0, Math.round(input.commissionAmountInPaise ?? 0));
  }

  return Math.round((input.priceInPaise * (input.commissionPercentage ?? 0)) / 100);
}

export function areReferralPayoutsEqual(
  left?: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> | null,
  right?: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> | null
) {
  const normalizedLeft: NormalizedReferralPayout = {
    commissionType: left?.commissionType ?? 'PERCENTAGE',
    commissionPercent: left?.commissionPercent ?? 0,
    commissionAmountInPaise: left?.commissionAmountInPaise ?? null,
  };

  const normalizedRight: NormalizedReferralPayout = {
    commissionType: right?.commissionType ?? 'PERCENTAGE',
    commissionPercent: right?.commissionPercent ?? 0,
    commissionAmountInPaise: right?.commissionAmountInPaise ?? null,
  };

  return (
    normalizedLeft.commissionType === normalizedRight.commissionType &&
    normalizedLeft.commissionPercent === normalizedRight.commissionPercent &&
    normalizedLeft.commissionAmountInPaise === normalizedRight.commissionAmountInPaise
  );
}

export function distributeFixedAmountInPaise(
  totalAmountInPaise: number,
  weights: number[]
): number[] {
  if (weights.length === 0) {
    return [];
  }

  const normalizedTotal = Math.max(0, Math.round(totalAmountInPaise));
  const safeWeights = weights.map((weight) => Math.max(0, Math.round(weight)));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);

  if (totalWeight === 0) {
    const evenShare = Math.floor(normalizedTotal / safeWeights.length);
    return safeWeights.map((_weight, index) =>
      index === safeWeights.length - 1
        ? normalizedTotal - evenShare * (safeWeights.length - 1)
        : evenShare
    );
  }

  let allocated = 0;
  return safeWeights.map((weight, index) => {
    if (index === safeWeights.length - 1) {
      return normalizedTotal - allocated;
    }

    const share = Math.floor((normalizedTotal * weight) / totalWeight);
    allocated += share;
    return share;
  });
}
```

## Notes

- The full `payoutService.ts` source is reproduced verbatim in `payoutService_source.md` (sibling file in this directory) to preserve every line as-is.

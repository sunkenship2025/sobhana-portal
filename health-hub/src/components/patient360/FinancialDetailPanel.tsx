/**
 * FinancialDetailPanel — read-only bill financials for the inspector (§2, §6).
 *
 * Bill #, visit ref, Total / Discount(+reason) / Paid / Due / Method rows + the
 * payment chip. Read-only — all money mutations happen on the visit/bill flows
 * elsewhere. Trusts `dueAmountInPaise` from the backend (it already forces ₹0 on
 * cancelled / refunded visits — never re-derives due here).
 */
import { Separator } from "@/components/ui/separator";
import { StatusChip } from "./StatusChip";
import { formatCurrency } from "@/lib/patientDisplay";
import type { VisitTimelineItem, VisitPaymentStatus } from "@/types";

interface KvRowProps {
  label: string;
  children: React.ReactNode;
  emphasize?: boolean;
}

function KvRow({ label, children, emphasize }: KvRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={emphasize ? "font-semibold text-foreground" : "text-foreground"}>
        {children}
      </span>
    </div>
  );
}

interface FinancialDetailPanelProps {
  visit: VisitTimelineItem;
}

export function FinancialDetailPanel({ visit }: FinancialDetailPanelProps) {
  const hasBill = visit.hasBill ?? !!visit.billNumber;
  const discountAmount = visit.discount?.amount ?? visit.discountAmountInPaise ?? 0;
  const discountReason = visit.discount?.reason ?? visit.discountReason ?? null;
  const paid = visit.paidAmountInPaise ?? 0;
  const due = visit.dueAmountInPaise ?? 0;
  const isCancelled = String(visit.status).toUpperCase() === "CANCELLED";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">Billing</h4>
        {hasBill && (
          <StatusChip
            kind="payment"
            value={(visit.paymentStatus as VisitPaymentStatus | null) ?? null}
            dueAmountInPaise={due}
            paidAmountInPaise={paid}
          />
        )}
      </div>

      <div className="space-y-1.5">
        <KvRow label={hasBill ? "Bill #" : "Visit ref"}>
          <span className="font-mono">
            {hasBill ? visit.billNumber || "—" : visit.visitRef || visit.billNumber || "—"}
          </span>
        </KvRow>
        {hasBill && visit.visitRef && visit.visitRef !== visit.billNumber && (
          <KvRow label="Visit ref">
            <span className="font-mono">{visit.visitRef}</span>
          </KvRow>
        )}

        <Separator className="my-2" />

        <KvRow label="Total">{formatCurrency(visit.totalAmountInPaise)}</KvRow>

        {discountAmount > 0 && (
          <KvRow label={discountReason ? `Discount (${discountReason})` : "Discount"}>
            − {formatCurrency(discountAmount)}
          </KvRow>
        )}

        {hasBill && (visit.reversedChargeInPaise ?? 0) > 0 && (
          <KvRow label="Cancelled charge">
            − {formatCurrency(visit.reversedChargeInPaise ?? 0)}
          </KvRow>
        )}

        {hasBill && <KvRow label="Paid">{formatCurrency(paid)}</KvRow>}

        {hasBill && (visit.refundedAmountInPaise ?? 0) > 0 && (
          <KvRow
            label={
              visit.refundReason ? `Refunded (${visit.refundReason})` : "Refunded"
            }
          >
            {formatCurrency(visit.refundedAmountInPaise ?? 0)}
          </KvRow>
        )}

        {hasBill && (
          <KvRow label="Due" emphasize>
            {formatCurrency(due)}
          </KvRow>
        )}

        {hasBill && (
          <KvRow label="Method">{visit.paymentType || "—"}</KvRow>
        )}

        {!hasBill && (
          <p className="pt-1 text-xs text-muted-foreground">No new bill for this visit.</p>
        )}

        {isCancelled && (
          <p className="pt-1 text-xs text-muted-foreground">
            Cancelled — excluded from dues.
          </p>
        )}
      </div>
    </div>
  );
}

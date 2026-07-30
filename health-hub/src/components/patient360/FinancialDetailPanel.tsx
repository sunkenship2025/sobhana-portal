/**
 * FinancialDetailPanel — read-only bill financials for the inspector (§2, §6).
 *
 * Bill #, visit ref, Total / Discount(+reason) / Paid / Due / Method rows + the
 * payment chip. Read-only — all money mutations happen on the visit/bill flows
 * elsewhere. Trusts `dueAmountInPaise` from the backend (it already forces ₹0 on
 * cancelled / refunded visits — never re-derives due here).
 */
import { Pencil } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { StatusChip } from "./StatusChip";
import { formatCurrency } from "@/lib/patientDisplay";
import type { VisitTimelineItem, VisitPaymentStatus } from "@/types";

interface KvRowProps {
  label: string;
  children: React.ReactNode;
  emphasize?: boolean;
  /** Renders a quiet inline pencil after the value (correction affordance). */
  onEdit?: () => void;
  editLabel?: string;
}

function KvRow({ label, children, emphasize, onEdit, editLabel }: KvRowProps) {
  return (
    <div className="group flex items-baseline justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`inline-flex items-center gap-1.5 ${emphasize ? "font-semibold text-foreground" : "text-foreground"}`}
      >
        {children}
        {onEdit && (
          <button
            type="button"
            aria-label={editLabel || `Edit ${label}`}
            className="text-muted-foreground/50 transition-colors hover:text-foreground group-hover:text-muted-foreground"
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </span>
    </div>
  );
}

interface FinancialDetailPanelProps {
  visit: VisitTimelineItem;
  /** When set, a quiet pencil next to "Referred by" opens the correction dialog. */
  onEditReferral?: () => void;
  /** When set, a quiet pencil next to "Billed tests" opens the swap dialog. */
  onEditTests?: () => void;
}

export function FinancialDetailPanel({
  visit,
  onEditReferral,
  onEditTests,
}: FinancialDetailPanelProps) {
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

        {visit.domain === "DIAGNOSTICS" && (
          <KvRow
            label="Referred by"
            onEdit={onEditReferral}
            editLabel="Correct referred-by"
          >
            {visit.referralDoctor?.name ?? "Self"}
          </KvRow>
        )}

        {visit.domain === "DIAGNOSTICS" &&
          (visit.testOrders?.filter((o) => !o.cancelledAt).length ?? 0) > 0 && (
            <KvRow
              label="Billed tests"
              onEdit={onEditTests}
              editLabel="Edit billed tests"
            >
              {
                new Set(
                  visit.testOrders
                    ?.filter((o) => !o.cancelledAt)
                    .map((o) => o.productId ?? o.id),
                ).size
              }{" "}
              item(s)
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

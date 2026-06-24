/**
 * VisitRow — one visit card in the timeline (§2, §6, §8).
 *
 * A11y contract (§8): the row is a plain <div>. Its clickable header region is a
 * real <button> that is a SIBLING of the action buttons, never an ancestor —
 * nesting interactive controls inside a role="button" breaks AT semantics and
 * double-fires onSelect. The action buttons stopPropagation regardless.
 *
 * Chips render via StatusChip (payment / report / abnormal / cancelled). Compact
 * ReportActions live in the actions region. Cancelled visits get `.cancelled`
 * styling (opacity + strike) and a muted "excluded from dues" note.
 */
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { StatusChip } from "./StatusChip";
import { ReportActions } from "./ReportActions";
import { JumpToOriginalVisit } from "./JumpToOriginalVisit";
import { formatCurrency } from "@/lib/patientDisplay";
import type { ReportAction } from "@/hooks/patient360/useReportActions";
import type { VisitDomain, VisitPaymentStatus, VisitTimelineItem } from "@/types";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getDomainBadgeVariant(domain: VisitDomain): "default" | "secondary" {
  return domain === "DIAGNOSTICS" ? "default" : "secondary";
}

interface VisitRowProps {
  item: VisitTimelineItem;
  selected: boolean;
  /** True if a report action is in flight for THIS visit. */
  reportBusy: boolean;
  reportBusyAction?: ReportAction | null;
  onSelect: () => void;
  onViewReport: () => void;
  onJumpToOriginal: (visitId: string) => void;
}

export function VisitRow({
  item,
  selected,
  reportBusy,
  reportBusyAction,
  onSelect,
  onViewReport,
  onJumpToOriginal,
}: VisitRowProps) {
  const isDiagnostic = item.domain === "DIAGNOSTICS";
  const isCancelled = String(item.status).toUpperCase() === "CANCELLED";
  const hasBill = item.hasBill ?? !!item.billNumber;
  const reference = hasBill
    ? item.billNumber || item.visitRef || "—"
    : item.visitRef || item.billNumber || "—";

  return (
    <Card
      className={cn(
        "overflow-hidden transition-colors",
        selected && "ring-2 ring-primary",
        isCancelled && "opacity-60",
      )}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        {/* Clickable header region — a real <button>, SIBLING of the actions. */}
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-pressed={selected}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={getDomainBadgeVariant(item.domain)}>
              {isDiagnostic ? "DIAGNOSTICS" : "CLINIC"}
            </Badge>
            {!isDiagnostic && item.visitType && (
              <Badge variant="outline" className="text-xs font-normal">
                {item.visitType}
              </Badge>
            )}
            <span className={cn("text-sm font-medium", isCancelled && "line-through")}>
              {formatDate(item.createdAt)}
            </span>
            <span className="text-xs text-muted-foreground">· {item.branchName}</span>
            <span className="font-mono text-xs text-muted-foreground">· {reference}</span>
            {item.isRevisit && (
              <Badge variant="outline" className="border-blue-200 text-xs font-normal text-blue-700">
                Revisit
              </Badge>
            )}
          </div>

          {!isDiagnostic && item.doctorName && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              Doctor: <span className="text-foreground">{item.doctorName}</span>
            </p>
          )}

          {/* Chips: payment · report · abnormal · cancelled */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {isCancelled ? (
              <StatusChip kind="cancelled" />
            ) : (
              hasBill && (
                <StatusChip
                  kind="payment"
                  value={(item.paymentStatus as VisitPaymentStatus | null) ?? null}
                  dueAmountInPaise={item.dueAmountInPaise ?? 0}
                  paidAmountInPaise={item.paidAmountInPaise ?? 0}
                />
              )
            )}
            <StatusChip kind="report" value={item.reportState} />
            <StatusChip kind="abnormal" value={item.hasAbnormalResults === true} />
            <span className="text-sm font-semibold">
              {formatCurrency(item.totalAmountInPaise)}
            </span>
          </div>

          {item.isRevisit &&
            item.originalVisitId &&
            (item.originalVisitBillNumber || item.originalVisitDate || item.originalVisitVisitRef) && (
              <div className="mt-1.5">
                <JumpToOriginalVisit
                  originalVisitId={item.originalVisitId}
                  originalVisitVisitRef={item.originalVisitVisitRef}
                  originalVisitBillNumber={item.originalVisitBillNumber}
                  originalVisitDate={item.originalVisitDate}
                  onJump={onJumpToOriginal}
                />
              </div>
            )}

          {isCancelled && (
            <p className="mt-1 text-xs text-muted-foreground">— excluded from dues</p>
          )}
        </button>

        {/* Actions region — SIBLING of the clickable header (never nested). */}
        <div className="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
          <ReportActions
            visit={item}
            variant="compact"
            busy={reportBusy}
            busyAction={reportBusyAction}
            onView={onViewReport}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * ReportActions — View / Print / WhatsApp for a finalized diagnostics report
 * (§2, §6). Gated: `domain === 'DIAGNOSTICS' && reportState.kind ∈
 * {FINALIZED, PARTIALLY_FINALIZED}`. Renders nothing otherwise.
 *
 *  - `compact` (timeline row): a single "View report" button (the row stays
 *    scannable; print/WhatsApp live in the inspector).
 *  - `full` (inspector): View + Print + WhatsApp + the DeliveryStatusLine.
 *
 * All report side effects flow through the page-level `useReportActions` hook;
 * this component is presentational and receives the imperative handlers + the
 * per-visit `busy` flags as props (so visit A's spinner never disables visit B).
 */
import { Button } from "@/components/ui/button";
import {
  Eye,
  EyeOff,
  Loader2,
  MessageCircle,
  Printer,
} from "lucide-react";
import { DeliveryStatusLine } from "./DeliveryStatusLine";
import type { ReportAction } from "@/hooks/patient360/useReportActions";
import type { VisitTimelineItem } from "@/types";

const VIEWABLE_KINDS = new Set(["FINALIZED", "PARTIALLY_FINALIZED"]);

function formatPrintedAt(value: Date | string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function canViewReport(visit: VisitTimelineItem): boolean {
  return (
    visit.domain === "DIAGNOSTICS" &&
    !!visit.reportState &&
    VIEWABLE_KINDS.has(visit.reportState.kind)
  );
}

interface ReportActionsProps {
  visit: VisitTimelineItem;
  patientPhone?: string | null;
  variant: "compact" | "full";
  /** True for any in-flight report action on THIS visit. */
  busy: boolean;
  /** The specific in-flight action on this visit, or null. */
  busyAction?: ReportAction | null;
  /** True when the inline report preview for this visit is currently open. */
  reportActive?: boolean;
  /** When the report was last printed — turns the Print button green + shows a line. */
  reportPrintedAt?: Date | string | null;
  onView: () => void;
  onPrint?: () => void;
  onWhatsApp?: () => void;
}

export function ReportActions({
  visit,
  patientPhone,
  variant,
  busy,
  busyAction,
  reportActive = false,
  reportPrintedAt,
  onView,
  onPrint,
  onWhatsApp,
}: ReportActionsProps) {
  if (!canViewReport(visit)) return null;

  const isAction = (a: ReportAction) => busy && busyAction === a;
  const viewIcon = (cls: string) =>
    isAction("view") ? (
      <Loader2 className={`${cls} animate-spin`} aria-hidden="true" />
    ) : reportActive ? (
      <EyeOff className={cls} aria-hidden="true" />
    ) : (
      <Eye className={cls} aria-hidden="true" />
    );
  const viewLabel = isAction("view") ? "Loading…" : reportActive ? "Hide report" : "View report";

  if (variant === "compact") {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-xs"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onView();
        }}
      >
        {viewIcon("mr-1.5 h-3.5 w-3.5")}
        {viewLabel}
      </Button>
    );
  }

  // full
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button
          variant="outline"
          size="sm"
          className="justify-start"
          disabled={busy}
          onClick={onView}
        >
          {viewIcon("mr-2 h-4 w-4")}
          {viewLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className={`justify-start${
            reportPrintedAt
              ? " border-green-600 text-green-600 hover:bg-green-50 hover:text-green-700"
              : ""
          }`}
          disabled={busy}
          onClick={onPrint}
        >
          {isAction("print") ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {isAction("print") ? "Opening…" : "Print report"}
        </Button>
        {patientPhone && onWhatsApp && (
          <Button
            variant="outline"
            size="sm"
            className="justify-start text-green-600 hover:bg-green-50 hover:text-green-700 sm:col-span-2"
            disabled={busy}
            onClick={onWhatsApp}
          >
            {isAction("whatsapp") ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {isAction("whatsapp") ? "Sending…" : "Send on WhatsApp"}
          </Button>
        )}
      </div>
      {reportPrintedAt && (
        <p className="flex items-center gap-1.5 text-xs text-green-600">
          <Printer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Printed{formatPrintedAt(reportPrintedAt) ? ` · ${formatPrintedAt(reportPrintedAt)}` : ""}
          </span>
        </p>
      )}
      <DeliveryStatusLine delivery={visit.delivery ?? null} />
    </div>
  );
}

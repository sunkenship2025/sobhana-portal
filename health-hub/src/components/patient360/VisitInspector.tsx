/**
 * VisitInspector — desktop right pane / mobile bottom Drawer (§2, §5, §8).
 *
 * Replaces the legacy inline drawer + full-screen preview modal. Hosts the
 * financial panel, full ReportActions, a print-bill (and optional collect-
 * payment) link, and an INLINE iframe PDF preview (no separate modal).
 *
 * Close handling:
 *  - mobile: vaul Drawer handles ESC + backdrop + drag-to-dismiss via onOpenChange.
 *  - desktop: a visible ✕, a backdrop-less always-mounted pane, and an Escape
 *    keydown listener SCOPED TO THE PANE ELEMENT and attached ONLY while open
 *    (a document-level listener would close the edit Dialog underneath — §8).
 *
 * Blob lifecycle: `useReportActions` lives in the PAGE (survives the desktop↔
 * mobile swap so the hook can revoke on isMobile change). This component fires
 * `closePreview()` in an effect keyed on the selected visitId so switching to a
 * visit that never opens a preview still revokes the prior blob (§3.3/§5).
 */
import { useEffect, useRef } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText, Printer, ReceiptText, X } from "lucide-react";
import { toast } from "sonner";
import { FinancialDetailPanel } from "./FinancialDetailPanel";
import { ReportActions } from "./ReportActions";
import type { UseReportActions } from "@/hooks/patient360/useReportActions";
import type { VisitTimelineItem } from "@/types";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function openPrintBill(visit: VisitTimelineItem) {
  if (!visit.domain || !visit.visitId) {
    toast.error("Visit data is incomplete — cannot open print view.");
    return;
  }
  const domain = String(visit.domain).toUpperCase();
  // No noopener/noreferrer in the features string: those flags make window.open
  // return null even on success, misfiring the popup-blocker check. Same-origin
  // route, so opener isolation isn't needed.
  const opened = window.open(`/bill/print/${domain}/${visit.visitId}`, "_blank");
  if (!opened) {
    toast.error("Pop-up was blocked — allow pop-ups for this site and try again.");
  }
}

interface VisitInspectorProps {
  visit: VisitTimelineItem | null;
  open: boolean;
  onClose: () => void;
  patientPhone?: string | null;
  isMobile: boolean;
  reportActions: UseReportActions;
}

/** Shared inner body (financials + report actions + print-bill + inline PDF). */
function InspectorBody({
  visit,
  patientPhone,
  reportActions,
}: {
  visit: VisitTimelineItem;
  patientPhone?: string | null;
  reportActions: UseReportActions;
}) {
  const { preview, busy, viewReport, printReport, sendWhatsApp } = reportActions;
  const isDiagnostic = visit.domain === "DIAGNOSTICS";
  const showPreview = preview?.visitId === visit.visitId;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-semibold">
          {isDiagnostic ? "Diagnostic visit" : `Clinic visit${visit.visitType ? ` — ${visit.visitType}` : ""}`}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {visit.branchName} · {formatDate(visit.createdAt)}
          {!isDiagnostic && visit.doctorName ? ` · ${visit.doctorName}` : ""}
        </p>
      </div>

      <Separator />

      <FinancialDetailPanel visit={visit} />

      {isDiagnostic && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Report</h4>
            <ReportActions
              visit={visit}
              patientPhone={patientPhone}
              variant="full"
              busy={busy?.visitId === visit.visitId}
              busyAction={busy?.visitId === visit.visitId ? busy.action : null}
              onView={() => viewReport(visit.visitId)}
              onPrint={() => printReport(visit.visitId)}
              onWhatsApp={() => sendWhatsApp(visit.visitId)}
            />
          </div>
        </>
      )}

      <Separator />

      <div>
        <Button variant="outline" size="sm" className="w-full" onClick={() => openPrintBill(visit)}>
          {visit.hasBill ?? !!visit.billNumber ? (
            <ReceiptText className="mr-2 h-4 w-4" aria-hidden="true" />
          ) : (
            <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
          )}
          {visit.hasBill ?? !!visit.billNumber ? "Print bill" : "Print visit slip"}
        </Button>
        {/* Collect-payment deep-link is intentionally omitted for v1: there is no
            /clinic/billing route and /money/bills does not accept a visit filter
            (06-frontend-plan.md §4 / Q5). Print-bill is the supported path. */}
      </div>

      {/* Inline iframe PDF preview — no separate modal. */}
      {showPreview && preview && (
        <div className="overflow-hidden rounded-lg border bg-muted">
          <iframe
            src={preview.url}
            title="Report preview"
            className="h-[60vh] w-full bg-white"
          />
        </div>
      )}
    </div>
  );
}

export function VisitInspector({
  visit,
  open,
  onClose,
  patientPhone,
  isMobile,
  reportActions,
}: VisitInspectorProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { closePreview } = reportActions;

  // Visit-switch revoke: when the selected visit changes (including → null),
  // revoke the prior preview blob even if the new visit never opens a preview.
  useEffect(() => {
    closePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visit?.visitId]);

  // Desktop ESC: scoped to the pane element, attached ONLY while open — never a
  // document-level listener (which would close the edit Dialog underneath, §8).
  useEffect(() => {
    if (isMobile || !open) return;
    const node = paneRef.current;
    if (!node) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    node.addEventListener("keydown", onKeyDown);
    // Move focus into the pane so the scoped listener can fire.
    headingRef.current?.focus();
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [isMobile, open, onClose, visit?.visitId]);

  // --- Mobile: vaul bottom Drawer ------------------------------------------
  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
        <DrawerContent className="max-h-[90vh]">
          <DrawerHeader className="flex items-center justify-between text-left">
            <DrawerTitle className="flex items-center gap-2">
              Visit details
              <Badge variant="outline" className="text-xs font-normal">
                Read-only
              </Badge>
            </DrawerTitle>
          </DrawerHeader>
          <div className="overflow-y-auto px-4 pb-8">
            {visit && (
              <InspectorBody
                visit={visit}
                patientPhone={patientPhone}
                reportActions={reportActions}
              />
            )}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  // --- Desktop: always-mounted right pane ----------------------------------
  return (
    <div
      ref={paneRef}
      className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto rounded-lg border bg-card"
      tabIndex={-1}
    >
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 font-semibold focus-visible:outline-none"
        >
          Visit details
          <Badge variant="outline" className="text-xs font-normal">
            Read-only
          </Badge>
        </h3>
        {open && (
          <Button variant="ghost" size="icon" aria-label="Close visit details" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        )}
      </div>
      <div className="p-4">
        {open && visit ? (
          <InspectorBody
            visit={visit}
            patientPhone={patientPhone}
            reportActions={reportActions}
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="Select a visit"
            description="Pick a visit from the timeline to see its bill, report, and delivery status."
          />
        )}
      </div>
    </div>
  );
}

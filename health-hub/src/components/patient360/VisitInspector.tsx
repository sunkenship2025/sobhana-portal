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
import { useEffect, useRef, useState } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { EmptyState } from "@/components/ui/empty-state";
import { Ban, Eye, EyeOff, FileText, Link2Off, Loader2, MessageCircle, Printer, ReceiptText, Unlink, X, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";
import { EditReferralDialog } from "./EditReferralDialog";
import { FinancialDetailPanel } from "./FinancialDetailPanel";
import { DeliveryStatusLine } from "./DeliveryStatusLine";
import { NoReportStatus } from "./NoReportStatus";
import { PatientLinkDialog } from "./PatientLinkDialog";
import { RefundDialog } from "./RefundDialog";
import { ReportActions, canViewReport } from "./ReportActions";
import { SwapTestDialog } from "./SwapTestDialog";
import { useAuthStore } from "@/store/authStore";
import type { UseReportActions } from "@/hooks/patient360/useReportActions";
import type { VisitTimelineItem } from "@/types";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatPrintedAt(value: Date | string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
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

function openPrintPrescription(visit: VisitTimelineItem) {
  if (!visit.visitId) {
    toast.error("Visit data is incomplete — cannot open prescription.");
    return;
  }
  const opened = window.open(`/prescription/print/${visit.visitId}`, "_blank");
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
  const { preview, busy, viewReport, viewBill, printReport, sendWhatsApp, sendBillWhatsApp, markPrinted, closePreview } =
    reportActions;
  const { user } = useAuthStore();
  const isDiagnostic = visit.domain === "DIAGNOSTICS";

  // Optimistic "just printed" state so the green Printed line/button appears
  // immediately, before the timeline refetches. Reset when the visit changes.
  const [localPrinted, setLocalPrinted] = useState<{ report?: string; bill?: string }>({});
  useEffect(() => {
    setLocalPrinted({});
  }, [visit.visitId]);
  const reportPrintedAt = localPrinted.report ?? visit.reportPrintedAt ?? null;
  const billPrintedAt = localPrinted.bill ?? visit.billPrintedAt ?? null;
  const hasNoReportOrders = (visit.testOrders ?? []).some(
    (order) => !!order.noReportAt && !order.cancelledAt,
  );
  const activePreview = preview?.visitId === visit.visitId ? preview : null;
  const reportActive = activePreview?.kind === "report";
  const billActive = activePreview?.kind === "bill";
  const billDomain = String(visit.domain).toUpperCase();
  const hasBill = visit.hasBill ?? !!visit.billNumber;

  // Report-preview zoom (the bill preview is HTML and fits on its own). Driven
  // through the PDF viewer's own #zoom= param so it stays crisp; the iframe
  // remounts (via key) on change so the viewer re-applies the level.
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    setZoom(100);
  }, [reportActive, visit.visitId]);

  const [refundOpen, setRefundOpen] = useState(false);
  // null = closed; true = about to disable, false = about to re-enable.
  const [linkDialog, setLinkDialog] = useState<boolean | null>(null);
  // Order ids to pre-tick in the Cancel/Refund dialog when a test is removed via
  // the trash shortcut in the edit-tests pencil.
  const [refundPreselect, setRefundPreselect] = useState<string[] | null>(null);
  const [referralEditOpen, setReferralEditOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const hasActiveOrders = (visit.testOrders ?? []).some((order) => !order.cancelledAt);
  const isCancelledVisit = String(visit.status).toUpperCase() === "CANCELLED";
  // A finalized report is locked: no add / replace / remove of tests (money +
  // report are already out). The server rejects it too; cancel/refund stays
  // available as a money action, and referral edits are unaffected.
  const isFinalized = visit.reportStatus === "FINALIZED" || Boolean(visit.finalizedAt);
  const canRefund = isDiagnostic && hasBill && hasActiveOrders && !isCancelledVisit;
  // Patient online access (report link + bill QR + patient app) — one switch per
  // visit, owner + lab incharge only. A cancelled visit's links are already
  // revoked by the refund flow, so the control stays hidden there.
  const linkDisabled = !!visit.patientLinkDisabledAt;
  const canToggleLink =
    isDiagnostic &&
    !isCancelledVisit &&
    (user?.role === "owner" || user?.role === "lab_incharge");
  const canCorrect = isDiagnostic && hasBill && !isCancelledVisit;
  const canEditTests = canCorrect && hasActiveOrders && !isFinalized;

  const linkToggle = canToggleLink ? (
    <Button
      variant="ghost"
      size="icon"
      className={`h-6 w-6 ${
        linkDisabled ? "text-amber-600 hover:text-amber-700" : "text-muted-foreground"
      }`}
      title={
        linkDisabled
          ? "Online link is off — turn it back on"
          : "Disable the patient's online link"
      }
      onClick={() => setLinkDialog(!linkDisabled)}
    >
      {linkDisabled ? (
        <Link2Off className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Unlink className="h-4 w-4" aria-hidden="true" />
      )}
    </Button>
  ) : null;

  const linkOffNote = linkDisabled ? (
    <div className="space-y-0.5">
      <p className="flex items-center gap-1.5 text-xs text-amber-600">
        <Link2Off className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Online link off · patient asked to collect at the centre</span>
      </p>
      {(visit.patientLinkDisabledBy || visit.patientLinkDisabledReason) && (
        <p className="pl-5 text-xs text-muted-foreground">
          {[
            visit.patientLinkDisabledBy,
            formatPrintedAt(visit.patientLinkDisabledAt),
            visit.patientLinkDisabledReason,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </div>
  ) : null;

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

      <FinancialDetailPanel
        visit={visit}
        onEditReferral={canCorrect ? () => setReferralEditOpen(true) : undefined}
        onEditTests={canEditTests ? () => setSwapOpen(true) : undefined}
      />

      {isDiagnostic && (canViewReport(visit) || hasNoReportOrders) && (
        <>
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <h4 className="text-sm font-medium">Report</h4>
              {linkToggle}
            </div>
            <ReportActions
              visit={visit}
              patientPhone={patientPhone}
              variant="full"
              busy={busy?.visitId === visit.visitId}
              busyAction={busy?.visitId === visit.visitId ? busy.action : null}
              reportActive={reportActive}
              reportPrintedAt={reportPrintedAt}
              onView={() => viewReport(visit.visitId)}
              onPrint={() => {
                setLocalPrinted((p) => ({ ...p, report: new Date().toISOString() }));
                markPrinted(visit.visitId, "report");
                printReport(visit.visitId);
              }}
              onWhatsApp={() => sendWhatsApp(visit.visitId)}
              linkDisabled={linkDisabled}
            />
            <NoReportStatus visit={visit} />
            {linkOffNote}
          </div>
        </>
      )}

      <Separator />

      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <h4 className="text-sm font-medium">Bill</h4>
          {linkToggle}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {hasBill && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => viewBill(visit.visitId)}
            >
              {billActive ? (
                <EyeOff className="mr-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <Eye className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {billActive ? "Hide bill" : "View bill"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className={`justify-start${
              billPrintedAt
                ? " border-green-600 text-green-600 hover:bg-green-50 hover:text-green-700"
                : ""
            }`}
            onClick={() => {
              if (isDiagnostic) {
                setLocalPrinted((p) => ({ ...p, bill: new Date().toISOString() }));
                markPrinted(visit.visitId, "bill");
              }
              openPrintBill(visit);
            }}
          >
            {hasBill ? (
              <ReceiptText className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Printer className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {hasBill ? "Print bill" : "Print visit slip"}
          </Button>
          {hasBill && patientPhone && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start text-green-600 hover:bg-green-50 hover:text-green-700 sm:col-span-2"
              disabled={busy?.visitId === visit.visitId || linkDisabled}
              title={linkDisabled ? "Online link is off for this visit" : undefined}
              onClick={() => sendBillWhatsApp(visit.visitId)}
            >
              {busy?.visitId === visit.visitId && busy.action === "whatsapp-bill" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              )}
              {busy?.visitId === visit.visitId && busy.action === "whatsapp-bill"
                ? "Sending…"
                : "Send on WhatsApp"}
            </Button>
          )}
          {canRefund && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start text-destructive hover:bg-destructive/10 hover:text-destructive sm:col-span-2"
              onClick={() => setRefundOpen(true)}
            >
              <Ban className="mr-2 h-4 w-4" aria-hidden="true" />
              Cancel / Refund tests
            </Button>
          )}
        </div>
        {billPrintedAt && (
          <p className="flex items-center gap-1.5 text-xs text-green-600">
            <Printer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Printed{formatPrintedAt(billPrintedAt) ? ` · ${formatPrintedAt(billPrintedAt)}` : ""}
            </span>
          </p>
        )}
        <DeliveryStatusLine delivery={visit.billDelivery ?? null} />
        {!(isDiagnostic && (canViewReport(visit) || hasNoReportOrders)) && linkOffNote}
        {/* Collect-payment deep-link intentionally omitted for v1 (06-frontend-plan §4 / Q5);
            print-bill is the supported path. */}
      </div>

      {!isDiagnostic && (
        <>
          <Separator />
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Prescription</h4>
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start sm:w-auto"
              onClick={() => openPrintPrescription(visit)}
            >
              <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
              Print prescription
            </Button>
          </div>
        </>
      )}

      {canRefund && (
        <RefundDialog
          visit={visit}
          open={refundOpen}
          onOpenChange={(o) => {
            setRefundOpen(o);
            if (!o) setRefundPreselect(null);
          }}
          preselectOrderIds={refundPreselect ?? undefined}
        />
      )}
      {canToggleLink && linkDialog !== null && (
        <PatientLinkDialog
          visit={visit}
          disabling={linkDialog}
          open
          onOpenChange={(o) => !o && setLinkDialog(null)}
        />
      )}
      {canCorrect && (
        <EditReferralDialog
          visit={visit}
          open={referralEditOpen}
          onOpenChange={setReferralEditOpen}
        />
      )}
      {canEditTests && (
        <SwapTestDialog
          visit={visit}
          open={swapOpen}
          onOpenChange={setSwapOpen}
          onRemove={
            canRefund
              ? (orderIds) => {
                  setSwapOpen(false);
                  setRefundPreselect(orderIds);
                  setRefundOpen(true);
                }
              : undefined
          }
        />
      )}

      {/* Inline preview — report (blob PDF, native toolbar hidden for a cleaner
          look) or bill (the same-origin /bill/print route). No separate modal;
          toggled off by the View button, the header ✕, or Escape. */}
      {activePreview && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground">
              {reportActive ? "Report preview" : "Bill preview"}
            </span>
            <div className="flex items-center gap-1">
              {reportActive && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="Zoom out"
                    disabled={zoom <= 50}
                    onClick={() => setZoom((z) => Math.max(50, z - 25))}
                  >
                    <ZoomOut className="h-4 w-4" />
                  </Button>
                  <span className="w-9 text-center text-xs tabular-nums text-muted-foreground">
                    {zoom}%
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="Zoom in"
                    disabled={zoom >= 200}
                    onClick={() => setZoom((z) => Math.min(200, z + 25))}
                  >
                    <ZoomIn className="h-4 w-4" />
                  </Button>
                  <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label="Hide preview"
                onClick={closePreview}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {reportActive ? (
            <iframe
              key={`report-${zoom}`}
              src={`${activePreview.reportUrl}#toolbar=0&navpanes=0&zoom=${zoom}`}
              title="Report preview"
              className="h-[68vh] w-full bg-white"
            />
          ) : (
            <iframe
              src={`/bill/print/${billDomain}/${visit.visitId}`}
              title="Bill preview"
              className="h-[68vh] w-full bg-white"
            />
          )}
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
            <DrawerTitle>Visit details</DrawerTitle>
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

/**
 * The Prescription block of a clinic visit in Patient 360 — the same shape as the
 * diagnostics Report block: View (in the panel), Print (green once printed),
 * Send on WhatsApp with its delivery line, and for the owner Correct / Discard.
 *
 * View / Print / Send read /api/prescription-records, which stays up with the
 * doctor module switched off. Correct and Discard are the module's own actions,
 * so they only appear while it is on.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, FileText, Loader2, MessageCircle, PenLine, Printer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RxLetterpad } from "@/components/doctor/RxLetterpad";
import { DeliveryStatusLine } from "./DeliveryStatusLine";
import { doctorApi, type Prescription } from "@/lib/doctorApi";
import { rxInMode, rxRecords, rxSendBlock } from "@/lib/rxRecords";
import { useDigitalRx } from "@/lib/digitalRx";
import { useConfirm } from "@/hooks/use-confirm";
import { useAuthStore } from "@/store/authStore";
import type { VisitTimelineItem } from "@/types";

const when = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

function openPrint(visitId: string) {
  const opened = window.open(`/prescription/print/${visitId}`, "_blank");
  if (!opened) toast.error("Pop-up was blocked — allow pop-ups for this site and try again.");
}

export function PrescriptionSection({
  visit,
  patientPhone,
  linkToggle,
}: {
  visit: VisitTimelineItem;
  patientPhone?: string | null;
  linkToggle?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const { enabled: moduleOn } = useDigitalRx();
  const { confirm, ConfirmDialog } = useConfirm();
  const [viewing, setViewing] = useState<Prescription | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [sending, setSending] = useState(false);
  const [printedNow, setPrintedNow] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const rx = rxInMode(visit.prescription, moduleOn);
  const signed = rx?.signed ?? null;
  const draft = rx?.draft ?? null;
  const doctor = signed?.doctorName ?? visit.doctorName ?? "the doctor";
  const isOwner = user?.role === "owner";
  const linkDisabled = !!visit.patientLinkDisabledAt;
  const printedAt = printedNow ?? signed?.printedAt ?? null;
  const sendBlock = rxSendBlock(rx, { linkDisabled, hasPhone: !!patientPhone });
  const refresh = () => qc.invalidateQueries({ queryKey: ["patient360"] });

  const toggleView = async () => {
    if (viewing) { setViewing(null); return; }
    setLoadingView(true);
    try {
      const { prescription } = await rxRecords.forVisit(visit.visitId);
      if (prescription) setViewing(prescription);
      else toast.error("No signed prescription to show");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the prescription");
    } finally {
      setLoadingView(false);
    }
  };

  const print = () => {
    if (signed) {
      setPrintedNow(new Date().toISOString());
      void rxRecords.markPrinted(signed.id).then(refresh).catch(() => {});
    }
    openPrint(visit.visitId);
  };

  const send = async () => {
    if (!signed) return;
    setSending(true);
    try {
      const { sent } = await rxRecords.send(signed.id);
      if (sent.success) toast.success("Prescription sent on WhatsApp.");
      else toast.error(sent.error ?? "Could not send the prescription");
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send the prescription");
    } finally {
      setSending(false);
    }
  };

  const correct = async () => {
    if (!signed || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await doctorApi.amend(signed.id, reason.trim());
      toast.success(`Correction opened — ${doctor} signs it from their queue. The patient keeps the current one until then.`);
      setCorrecting(false);
      setReason("");
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open a correction");
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!draft) return;
    const ok = await confirm({
      title: draft.isCorrection ? "Discard this correction?" : "Discard this draft?",
      description: draft.isCorrection
        ? `The unsigned correction is thrown away. The prescription ${doctor} already signed stays as it is.`
        : `${doctor}'s unsigned prescription for this visit is thrown away, with its recording. This cannot be undone.`,
      confirmText: "Discard",
      destructive: true,
    });
    if (!ok) return;
    try {
      await doctorApi.discard(draft.id);
      toast.success("Draft discarded");
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not discard the draft");
    }
  };

  // What the prescription is, in one line — the panel's equivalent of the chip.
  const status = signed ? (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">v{signed.version}</span>
      {signed.revised ? " · revised" : ""} · signed {when(signed.signedAt)} · {signed.doctorName}
    </p>
  ) : draft ? (
    <p className="text-sm text-amber-700">Draft · not signed by {doctor} yet</p>
  ) : rx?.outcome === "NONE" ? (
    <p className="text-sm text-muted-foreground">No Rx given — the doctor closed the visit without one</p>
  ) : rx?.outcome === "PAPER" ? (
    <p className="text-sm text-muted-foreground">Paper — reception closed the visit; written on the pad</p>
  ) : null;

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <div className="flex items-center gap-1">
          <h4 className="text-sm font-medium">Prescription</h4>
          {signed && linkToggle}
        </div>
        {status}
        {signed && draft?.isCorrection && (
          <p className="text-xs text-amber-700">
            A correction is open — {doctor} has not signed it yet. The patient keeps this version until then.
          </p>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {signed && (
            <Button variant="outline" size="sm" className="justify-start" disabled={loadingView} onClick={() => void toggleView()}>
              {loadingView ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                : viewing ? <EyeOff className="mr-2 h-4 w-4" aria-hidden="true" />
                : <Eye className="mr-2 h-4 w-4" aria-hidden="true" />}
              {viewing ? "Hide prescription" : "View prescription"}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className={`justify-start${printedAt ? " border-green-600 text-green-600 hover:bg-green-50 hover:text-green-700" : ""}`}
            onClick={print}
          >
            {signed ? <Printer className="mr-2 h-4 w-4" aria-hidden="true" /> : <FileText className="mr-2 h-4 w-4" aria-hidden="true" />}
            {signed ? "Print" : rx ? "Print blank sheet" : "Print prescription"}
          </Button>
          {signed && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start text-green-600 hover:bg-green-50 hover:text-green-700 sm:col-span-2"
              disabled={!!sendBlock || sending}
              title={sendBlock ?? undefined}
              onClick={() => void send()}
            >
              {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <MessageCircle className="mr-2 h-4 w-4" aria-hidden="true" />}
              {sending ? "Sending…" : rx?.delivery ? "Send again on WhatsApp" : "Send on WhatsApp"}
            </Button>
          )}
        </div>

        {printedAt && (
          <p className="flex items-center gap-1.5 text-xs text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Printed · {when(printedAt)}</span>
          </p>
        )}
        {signed && <DeliveryStatusLine delivery={rx?.delivery ?? null} />}

        {/* The module's own actions: only while it is on, and only for the owner
            here — the doctor corrects and discards from their own screen. */}
        {moduleOn && isOwner && ((signed && !draft) || draft) && (
          <div className="flex flex-wrap gap-2">
            {signed && !draft && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setCorrecting(true)}>
                <PenLine className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Correct…
              </Button>
            )}
            {draft && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-destructive hover:text-destructive" onClick={() => void discard()}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> {draft.isCorrection ? "Discard correction" : "Discard draft"}
              </Button>
            )}
          </div>
        )}

        {viewing && (
          <div className="max-h-[70vh] overflow-auto rounded-md border bg-muted/40 p-2">
            <RxLetterpad
              profile="digital"
              items={viewing.items}
              diagnosis={viewing.diagnosis}
              notes={viewing.notes}
              followUpDays={viewing.followUpDays}
              snapshot={viewing.snapshot}
            />
          </div>
        )}
      </div>

      <Dialog open={correcting} onOpenChange={(o) => { if (!o) { setCorrecting(false); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct this prescription</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A new version opens as a draft for {doctor} to edit and sign. Until they sign it, the patient's link and
            every printout stay on the version signed {when(signed?.signedAt)}.
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why — e.g. wrong dose on Augmentin, patient allergic to penicillin"
            aria-label="Reason for the correction"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setCorrecting(false); setReason(""); }}>Cancel</Button>
            <Button disabled={reason.trim().length < 3 || busy} onClick={() => void correct()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Open correction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {ConfirmDialog}
    </>
  );
}

/**
 * PatientLinkDialog — switch this visit's patient-facing online access off / on.
 *
 * One switch covers every public door: the report link, the bill QR gateway, the
 * bill PDF and the patient app all answer "collect at the centre", and the
 * report/bill WhatsApp sends stop firing. Owner + lab_incharge only (the icon
 * that opens this is hidden for everyone else); lab_incharge must give a reason.
 */
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Link2, Link2Off, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import type { VisitTimelineItem } from "@/types";

const REASON_PRESETS = [
  "Payment pending",
  "Report under correction",
  "Doctor asked to hand over in person",
  "Wrong patient / identity issue",
  "Other",
] as const;

interface PatientLinkDialogProps {
  visit: VisitTimelineItem;
  /** true → the dialog is switching access OFF; false → back ON. */
  disabling: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PatientLinkDialog({
  visit,
  disabling,
  open,
  onOpenChange,
}: PatientLinkDialogProps) {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  // Owner may act without a reason; everyone else who can see this must give one.
  const reasonRequired = user?.role !== "owner";

  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setReason("");
    setNote("");
  }, [open, visit.visitId]);

  // "Other" is only a reason once it says something.
  const finalReason =
    reason === "Other" ? note.trim() : [reason, note.trim()].filter(Boolean).join(" · ");
  const canSubmit = !busy && (!reasonRequired || !!finalReason);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await apiRequest(`${API_BASE}/visits/diagnostic/${visit.visitId}/patient-link`, {
        method: "POST",
        headers: { "X-Branch-Id": visit.branchId },
        body: JSON.stringify({ disabled: disabling, reason: finalReason || undefined }),
      });
      qc.invalidateQueries({ queryKey: ["patient360"] });
      toast.success(
        disabling
          ? "Online link disabled — the patient is asked to collect at the centre"
          : "Online link is live again",
      );
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Could not update the patient link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {disabling
              ? "Disable the patient's online link?"
              : "Turn the patient's online link back on?"}
          </DialogTitle>
          <DialogDescription>
            {disabling
              ? "The report link, the bill QR and the patient app stop opening this visit — the patient is asked to collect at the centre and given the branch phone number. WhatsApp sends are blocked. Staff printing is unaffected."
              : "The report link, the bill QR and the patient app start working again for this visit."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="patient-link-reason">
              Reason{reasonRequired ? " *" : " (optional)"}
            </Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger id="patient-link-reason">
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {REASON_PRESETS.map((preset) => (
                  <SelectItem key={preset} value={preset}>
                    {preset}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={reason === "Other" ? "Type the reason" : "Add detail (optional)"}
          />
          <p className="text-xs text-muted-foreground">
            Recorded against your name in the owner audit log.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : disabling ? (
              <Link2Off className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Link2 className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {disabling ? "Disable link" : "Enable link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

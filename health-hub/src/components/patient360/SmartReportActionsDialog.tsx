/**
 * SmartReportActionsDialog — regenerate, or withdraw, this visit's Smart Report.
 *
 * Withdrawing is the after-the-fact remedy for a summary that reads wrong.
 * Generation and the first WhatsApp both hang off finalize, fire-and-forget, so
 * nothing can pre-empt the first message; what this does is stop the smart page
 * being served and make every resend fall back to the plain one-button template.
 * The signed lab report is untouched either way.
 *
 * Reason is required to withdraw — a patient may already have opened the link,
 * so the audit trail should say why it was pulled. Owner + lab_incharge only.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RefreshCw, EyeOff, Eye } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";

const REASON_PRESETS = [
  "Summary reads incorrectly",
  "Wording is not appropriate for this patient",
  "Doctor asked to withhold it",
  "Wrong patient / identity issue",
  "Other",
] as const;

interface Props {
  visitId: string;
  /** null = closed; 'regenerate' | 'withdraw' | 'restore' = open in that mode. */
  mode: "regenerate" | "withdraw" | "restore" | null;
  onClose: () => void;
}

export function SmartReportActionsDialog({ visitId, mode, onClose }: Props) {
  const token = useAuthStore((s) => s.token);
  const branchId = useBranchStore((s) => s.selectedBranchId);
  const qc = useQueryClient();
  const [preset, setPreset] = useState<string>("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  const reason = preset === "Other" ? detail.trim() : [preset, detail.trim()].filter(Boolean).join(" — ");
  const needsReason = mode === "withdraw";
  const canSubmit = !busy && (!needsReason || reason.length >= 3);

  const run = async () => {
    setBusy(true);
    try {
      const headers = { "X-Branch-Id": branchId ?? "", Authorization: `Bearer ${token}` };
      if (mode === "regenerate") {
        await apiRequest(`${API_BASE}/smart-reports/visits/${visitId}/generate`, { method: "POST", headers });
        toast.success("Smart Report regenerated");
      } else {
        await apiRequest(`${API_BASE}/smart-reports/visits/${visitId}/send-suppressed`, {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ suppressed: mode === "withdraw", reason }),
        });
        toast.success(mode === "withdraw" ? "Smart Report withdrawn" : "Smart Report restored");
      }
      await qc.invalidateQueries({ queryKey: ["patient360"] });
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not complete that action.");
    } finally {
      setBusy(false);
    }
  };

  const title = mode === "regenerate" ? "Regenerate Smart Report"
    : mode === "withdraw" ? "Withdraw Smart Report" : "Restore Smart Report";
  const description = mode === "regenerate"
    ? "Runs the summary again and replaces the current one. The signed lab report is not affected."
    : mode === "withdraw"
      ? "The patient's Smart Report link stops working and any resend goes out as the plain report message. The signed lab report is not affected."
      : "The Smart Report link works again and resends may include it.";

  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {needsReason && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-sm">Reason</Label>
              <Select value={preset} onValueChange={setPreset}>
                <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                <SelectContent>
                  {REASON_PRESETS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">
                {preset === "Other" ? "Describe the reason" : "Anything to add (optional)"}
              </Label>
              <Textarea rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void run()} disabled={!canSubmit}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : mode === "regenerate" ? <RefreshCw className="mr-2 h-4 w-4" />
              : mode === "withdraw" ? <EyeOff className="mr-2 h-4 w-4" />
              : <Eye className="mr-2 h-4 w-4" />}
            {mode === "regenerate" ? "Regenerate" : mode === "withdraw" ? "Withdraw" : "Restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

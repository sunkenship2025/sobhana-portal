/**
 * MakeSelfDialog — confirm converting the selected patients on a referral
 * doctor's payout statement to SELF (walk-in). This drops those visits from the
 * doctor's commission and off the doctors dashboard, but keeps the original
 * referral link in the DB as history (soft-delete). A reason is mandatory; an
 * optional note is recorded in the audit trail.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";

const REASON_PRESETS = [
  "Referral entered by mistake",
  "Walk-in / self patient",
  "Doctor did not refer",
  "Owner adjustment",
  "Other",
] as const;

interface MakeSelfDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  doctorName: string;
  busy: boolean;
  onConfirm: (reason: string, note: string | null) => void;
}

export function MakeSelfDialog({
  open,
  onOpenChange,
  count,
  doctorName,
  busy,
  onConfirm,
}: MakeSelfDialogProps) {
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState<string>("");

  // Reset when the dialog reopens.
  useEffect(() => {
    if (open) {
      setReason("");
      setNote("");
    }
  }, [open]);

  const finalReason = reason === "Other" ? note.trim() : reason;
  const canSubmit = !busy && count > 0 && Boolean(finalReason);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make {count} {count === 1 ? "patient" : "patients"} self?</DialogTitle>
          <DialogDescription>
            These {count === 1 ? "visit" : "visits"} will no longer be referred by{" "}
            <span className="font-medium">{doctorName}</span> — they become Self (walk-in),
            so their commission leaves this doctor's payout. The original referral is kept
            in the records as history; this can be reversed by re-assigning the doctor.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Select a reason" />
              </SelectTrigger>
              <SelectContent>
                {REASON_PRESETS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              {reason === "Other" ? "Describe the reason" : "Note (optional)"}
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={reason === "Other" ? "Required" : "Any extra detail"}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(finalReason, note.trim() ? note.trim() : null)}
            disabled={!canSubmit}
          >
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Make self
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

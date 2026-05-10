/**
 * Single-doctor "derive payout" dialog.
 *
 * Extracted from the old PayoutsList so the rewritten page stays focused.
 * Defaults the period to last completed calendar month (matches the new
 * monthly-cycle workflow). After derive, calls onDerived() — the caller is
 * responsible for refreshing the list. We deliberately do NOT navigate away
 * to the detail page (a behaviour the user disliked).
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/api";
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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { toast } from "sonner";
import type { PayoutDoctorType } from "@/types";

export interface DerivePayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  referralDoctors: { id: string; name: string }[];
  clinicDoctors: { id: string; name: string }[];
  diagnosticCenters: { id: string; name: string }[];
  defaultRange: { startDate: string; endDate: string };
  onDerived: () => void;
}

export function DerivePayoutDialog({
  open,
  onOpenChange,
  referralDoctors,
  clinicDoctors,
  diagnosticCenters,
  defaultRange,
  onDerived,
}: DerivePayoutDialogProps) {
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [busy, setBusy] = useState(false);
  const [doctorType, setDoctorType] = useState<PayoutDoctorType>("REFERRAL");
  const [doctorId, setDoctorId] = useState<string>("");
  const [startDate, setStartDate] = useState(defaultRange.startDate);
  const [endDate, setEndDate] = useState(defaultRange.endDate);

  useEffect(() => {
    if (open) {
      setDoctorId("");
      setStartDate(defaultRange.startDate);
      setEndDate(defaultRange.endDate);
    }
  }, [open, defaultRange.startDate, defaultRange.endDate]);

  useEffect(() => {
    setDoctorId("");
  }, [doctorType]);

  const options =
    doctorType === "REFERRAL"
      ? referralDoctors
      : doctorType === "CLINIC"
        ? clinicDoctors
        : diagnosticCenters;

  const submit = async () => {
    if (!doctorId) {
      toast.error("Pick a doctor");
      return;
    }
    if (!startDate || !endDate) {
      toast.error("Pick a date range");
      return;
    }
    if (new Date(startDate) > new Date(endDate)) {
      toast.error("Start date must be before end date");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/derive`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Branch-Id": activeBranchId ?? "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          doctorType,
          doctorId,
          periodStartDate: new Date(`${startDate}T00:00:00`).toISOString(),
          periodEndDate: new Date(`${endDate}T23:59:59.999`).toISOString(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message ?? "Failed to derive");
        return;
      }
      toast.success(data.isNew ? "Payout derived" : "Existing payout returned");
      onDerived();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Derive Single Payout</DialogTitle>
          <DialogDescription>
            Calculate one doctor's commission for a specific period.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Doctor Type</Label>
            <Select
              value={doctorType}
              onValueChange={(v) => setDoctorType(v as PayoutDoctorType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="REFERRAL">Referral Doctor</SelectItem>
                <SelectItem value="CLINIC">Clinic Doctor</SelectItem>
                <SelectItem value="DIAGNOSTIC_CENTER">Diagnostic Center</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Doctor</Label>
            <SearchableSelect
              value={doctorId}
              onValueChange={setDoctorId}
              options={options.map((d) => ({ value: d.id, label: d.name }))}
              placeholder="Select a doctor"
              searchPlaceholder="Type to search…"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>End Date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !doctorId}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deriving…
              </>
            ) : (
              "Derive Payout"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

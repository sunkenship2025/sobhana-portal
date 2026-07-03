/**
 * EditReferralDialog — correct a wrongly-entered referring doctor on a billed
 * visit (Patient360 inspector). Pick an existing doctor, "Self", or quick-add
 * a new doctor (same contract as the New Visit dialog, 50% default). A reason
 * is mandatory; the backend re-freezes commission snapshots, audit-logs the
 * old → new change, and refuses once a payout run already covers the visit.
 */
import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, Loader2, Plus, UserRound } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import type { VisitTimelineItem } from "@/types";

const REASON_PRESETS = [
  "Missed entering the doctor",
  "Wrong doctor selected",
  "Doctor name updated",
  "Other",
] as const;

interface ReferralDoctorLite {
  id: string;
  name: string;
}

interface EditReferralDialogProps {
  visit: VisitTimelineItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditReferralDialog({
  visit,
  open,
  onOpenChange,
}: EditReferralDialogProps) {
  const qc = useQueryClient();
  const currentId = visit.referralDoctor?.id ?? null;

  const [doctors, setDoctors] = useState<ReferralDoctorLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(currentId);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Quick-add state
  const [adding, setAdding] = useState(false);
  const [newPhone, setNewPhone] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedId(currentId);
    setReason("");
    setNote("");
    setAdding(false);
    setNewPhone("");
    setLoading(true);
    apiRequest<ReferralDoctorLite[]>(`${API_BASE}/referral-doctors`, {
      headers: { "X-Branch-Id": visit.branchId },
    })
      .then((list) => setDoctors(Array.isArray(list) ? list : []))
      .catch(() => toast.error("Could not load referral doctors"))
      .finally(() => setLoading(false));
  }, [open, visit.visitId, visit.branchId, currentId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? doctors.filter((doc) => doc.name.toLowerCase().includes(q))
      : doctors;
    return list.slice(0, 30);
  }, [doctors, query]);

  const quickAdd = async () => {
    const name = query.trim();
    if (!name) return;
    setCreating(true);
    try {
      const doctor = await apiRequest<ReferralDoctorLite>(
        `${API_BASE}/referral-doctors`,
        {
          method: "POST",
          headers: { "X-Branch-Id": visit.branchId },
          body: JSON.stringify({
            name,
            phone: newPhone.trim() || undefined,
            commissionType: "PERCENTAGE",
            commissionPercent: 50,
          }),
        },
      );
      setDoctors((prev) => [...prev, doctor]);
      setSelectedId(doctor.id);
      setAdding(false);
      toast.success(`Added ${doctor.name}`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to add doctor");
    } finally {
      setCreating(false);
    }
  };

  const submit = async () => {
    if (!reason || selectedId === currentId) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ newReferralDoctorName: string | null }>(
        `${API_BASE}/visits/diagnostic/${visit.visitId}/correct-referral`,
        {
          method: "POST",
          headers: { "X-Branch-Id": visit.branchId },
          body: JSON.stringify({
            referralDoctorId: selectedId,
            reason,
            note: note.trim() || undefined,
          }),
        },
      );
      qc.invalidateQueries({ queryKey: ["patient360"] });
      toast.success(
        result.newReferralDoctorName
          ? `Referral updated to ${result.newReferralDoctorName}`
          : "Referral set to Self",
      );
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to update referral");
    } finally {
      setBusy(false);
    }
  };

  const selectedName =
    selectedId === null
      ? "Self"
      : doctors.find((doc) => doc.id === selectedId)?.name ?? "…";

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Correct referred-by</DialogTitle>
          <DialogDescription>
            Bill {visit.billNumber || visit.visitRef} — currently{" "}
            {visit.referralDoctor?.name ?? "Self"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Input
              placeholder="Search doctors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-h-[30vh] space-y-0.5 overflow-y-auto rounded-lg border p-1">
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${selectedId === null ? "bg-muted font-medium" : ""}`}
                onClick={() => setSelectedId(null)}
              >
                <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                Self (no referral)
                {selectedId === null && <Check className="ml-auto h-3.5 w-3.5" />}
              </button>
              {loading && (
                <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                </div>
              )}
              {filtered.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${selectedId === doc.id ? "bg-muted font-medium" : ""}`}
                  onClick={() => setSelectedId(doc.id)}
                >
                  {doc.name}
                  {selectedId === doc.id && <Check className="ml-auto h-3.5 w-3.5" />}
                </button>
              ))}
              {!loading && query.trim() && (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-primary hover:bg-muted/60"
                  onClick={() => setAdding(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add "{query.trim()}" as a new doctor
                </button>
              )}
            </div>
          </div>

          {adding && (
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              <Label>New doctor: {query.trim()}</Label>
              <Input
                placeholder="Phone (optional)"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={creating} onClick={quickAdd}>
                  {creating ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Add doctor
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
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

          <div className="space-y-2">
            <Label>Note (optional)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Extra detail for the record"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button
            disabled={busy || !reason || selectedId === currentId}
            onClick={submit}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save — {selectedName}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

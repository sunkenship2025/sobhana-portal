import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useApiQuery, useApiMutation, branchRequest, useBranchId, qk } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { OwnerPageHeader } from "./_shared/ownerUi";
import { formatRupees } from "@/lib/payoutFormatters";
import type { ExternalLab, ReferralPayoutType } from "@/types";

const EMPTY_FORM = {
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  address: "",
  rateType: "PERCENTAGE" as ReferralPayoutType,
  ratePercent: "0",
  rateAmount: "0", // rupees
};

function rateLabel(lab: ExternalLab): string {
  return lab.rateType === "FIXED_AMOUNT"
    ? `${formatRupees(lab.rateAmountInPaise ?? 0)} / test`
    : `${lab.ratePercent}% of price`;
}

export default function OutsideLabs() {
  const branchId = useBranchId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const { data: labs = [], isLoading } = useApiQuery<ExternalLab[]>({
    branchScoped: true,
    queryKey: qk.externalLabs(branchId),
    queryFn: () =>
      branchRequest<ExternalLab[]>("/external-labs?includeInactive=true", branchId!),
  });

  const saveMutation = useApiMutation<
    ExternalLab,
    { editingId: string | null; payload: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, payload }) =>
      branchRequest<ExternalLab>(
        editingId ? `/external-labs/${editingId}` : "/external-labs",
        branchId!,
        { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) }
      ),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: (_d, { editingId }) => {
      toast.success(editingId ? "Outside lab updated" : "Outside lab created");
      resetForm();
    },
    onError: (err) => toast.error(err.message || "Failed to save outside lab"),
  });

  const toggleMutation = useApiMutation<ExternalLab, ExternalLab>({
    mutationFn: (lab) =>
      branchRequest<ExternalLab>(`/external-labs/${lab.id}`, branchId!, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !lab.isActive }),
      }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: (_d, lab) => toast.success(`Lab ${!lab.isActive ? "activated" : "deactivated"}`),
    onError: (err) => toast.error(err.message || "Failed to update status"),
  });

  const deleteMutation = useApiMutation<void, string>({
    mutationFn: (id) =>
      branchRequest<void>(`/external-labs/${id}`, branchId!, { method: "DELETE" }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: () => toast.success("Outside lab deactivated"),
    onError: (err) => toast.error(err.message || "Failed to delete lab"),
    onSettled: () => setDeleteId(null),
  });

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setDialogOpen(true);
  };

  const handleEdit = (lab: ExternalLab) => {
    setForm({
      name: lab.name,
      contactPerson: lab.contactPerson || "",
      phone: lab.phone || "",
      email: lab.email || "",
      address: lab.address || "",
      rateType: lab.rateType,
      ratePercent: String(lab.ratePercent ?? 0),
      rateAmount: String((lab.rateAmountInPaise ?? 0) / 100),
    });
    setEditingId(lab.id);
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast.error("Lab name is required");
      return;
    }
    const payload: Record<string, unknown> = {
      name: form.name.trim(),
      contactPerson: form.contactPerson.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      rateType: form.rateType,
    };
    if (form.rateType === "FIXED_AMOUNT") {
      const amt = parseFloat(form.rateAmount);
      if (isNaN(amt) || amt < 0) {
        toast.error("Fixed rate must be a non-negative number");
        return;
      }
      payload.rateAmount = amt;
    } else {
      const pct = parseFloat(form.ratePercent);
      if (isNaN(pct) || pct < 0 || pct > 100) {
        toast.error("Rate percent must be between 0 and 100");
        return;
      }
      payload.ratePercent = pct;
    }
    saveMutation.mutate({ editingId, payload });
  };

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1100 }}>
        <OwnerPageHeader
          title="Payouts · Outside Labs & rates"
          subtitle="Vendor labs we send tests to. Set the rate we pay each; these drive the lab payables."
          rightSlot={
            <Button onClick={handleAdd}>
              <Plus className="mr-2 h-4 w-4" /> Add lab
            </Button>
          }
        />

        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Loading outside labs…</div>
        ) : labs.length === 0 ? (
          <EmptyState title="No outside labs yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lab #</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Default rate</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {labs.map((lab) => (
                <TableRow key={lab.id} className={!lab.isActive ? "opacity-50" : ""}>
                  <TableCell className="font-mono">{lab.labNumber}</TableCell>
                  <TableCell className="font-medium">{lab.name}</TableCell>
                  <TableCell>{rateLabel(lab)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {lab.contactPerson || lab.phone || "---"}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch checked={lab.isActive} onCheckedChange={() => toggleMutation.mutate(lab)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(lab)} aria-label="Edit lab">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleteId(lab.id)} aria-label="Delete lab">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          Per-test rate overrides and the reduced referring-doctor commission on outsourced tests
          are configured per product (coming next); each lab uses its default rate until then.
        </p>
      </div>

      {/* Create / Edit */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) resetForm(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit outside lab" : "Add outside lab"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="lab-name">Name *</Label>
              <Input
                id="lab-name"
                placeholder="e.g. Thyrocare (Mumbai)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="lab-contact">Contact person</Label>
                <Input
                  id="lab-contact"
                  value={form.contactPerson}
                  onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lab-phone">Phone</Label>
                <Input
                  id="lab-phone"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  maxLength={10}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Default rate (what we pay the lab)</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={form.rateType}
                  onValueChange={(v) => setForm({ ...form, rateType: v as ReferralPayoutType })}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PERCENTAGE">Percentage</SelectItem>
                    <SelectItem value="FIXED_AMOUNT">Fixed amount</SelectItem>
                  </SelectContent>
                </Select>
                {form.rateType === "FIXED_AMOUNT" ? (
                  <div className="flex items-center gap-1">
                    <span className="text-muted-foreground">₹</span>
                    <Input
                      type="number"
                      className="w-28"
                      min={0}
                      value={form.rateAmount}
                      onChange={(e) => setForm({ ...form, rateAmount: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground">/ test</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      className="w-24"
                      min={0}
                      max={100}
                      value={form.ratePercent}
                      onChange={(e) => setForm({ ...form, ratePercent: e.target.value })}
                    />
                    <span className="text-sm text-muted-foreground">% of price</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={resetForm} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving…" : editingId ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this outside lab?</AlertDialogTitle>
            <AlertDialogDescription>
              It will no longer appear in active lists, but existing payouts and order history are
              preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground"
            >
              {deleteMutation.isPending ? "Deactivating…" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

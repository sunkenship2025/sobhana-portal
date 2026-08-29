import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { toast } from "sonner";
import { Archive, FlaskConical, Plus, Pencil, X } from "lucide-react";
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
import { OwnerPageHeader, SectionCard, EmptyState, FullPageSkeleton, TOKENS } from "./_shared/ownerUi";
import { formatRupees } from "@/lib/payoutFormatters";
import type { ExternalLab, ReferralPayoutType } from "@/types";

interface ProductLite {
  id: string;
  name: string;
  code: string;
}

interface OverrideRow {
  productId: string;
  rateType: ReferralPayoutType;
  ratePercent: string;
  rateAmount: string;
  reduceDoctor: boolean;
  reducedType: ReferralPayoutType;
  reducedPercent: string;
  reducedAmount: string;
}

const EMPTY_FORM = {
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  address: "",
  rateType: "PERCENTAGE" as ReferralPayoutType,
  ratePercent: "0",
  rateAmount: "0",
  overrides: [] as OverrideRow[],
};

function rateLabel(lab: ExternalLab): string {
  return lab.rateType === "FIXED_AMOUNT"
    ? `${formatRupees(lab.rateAmountInPaise ?? 0)} / test`
    : `${lab.ratePercent}% of price`;
}

export default function OutsideLabs() {
  const navigate = useNavigate();
  const branchId = useBranchId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const { data: labs = [], isLoading } = useApiQuery<ExternalLab[]>({
    branchScoped: true,
    // "all" keeps this off the active-only key New Visit reads — same key +
    // different URL meant whichever page loaded first served the other one.
    queryKey: [...qk.externalLabs(branchId), "all"],
    queryFn: () =>
      branchRequest<ExternalLab[]>("/external-labs?includeInactive=true", branchId!),
  });

  const { data: products = [] } = useApiQuery<ProductLite[]>({
    branchScoped: true,
    // Same list New Visit downloads — share its key so a price edit refreshes both.
    queryKey: qk.billableProducts(branchId),
    queryFn: () => branchRequest<ProductLite[]>("/billable-products", branchId!),
  });
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

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
    setForm({ ...EMPTY_FORM, overrides: [] });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    setForm({ ...EMPTY_FORM, overrides: [] });
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
      overrides: (lab.productRules ?? []).map((r) => ({
        productId: r.productId,
        rateType: r.rateType,
        ratePercent: String(r.ratePercent ?? 0),
        rateAmount: String((r.rateAmountInPaise ?? 0) / 100),
        reduceDoctor: r.reducedReferralCommissionType != null,
        reducedType: r.reducedReferralCommissionType ?? "PERCENTAGE",
        reducedPercent: String(r.reducedReferralCommissionPercent ?? 0),
        reducedAmount: String((r.reducedReferralCommissionAmountInPaise ?? 0) / 100),
      })),
    });
    setEditingId(lab.id);
    setDialogOpen(true);
  };

  const setOverride = (idx: number, patch: Partial<OverrideRow>) =>
    setForm((f) => ({
      ...f,
      overrides: f.overrides.map((o, i) => (i === idx ? { ...o, ...patch } : o)),
    }));

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
      if (isNaN(amt) || amt < 0) return toast.error("Fixed rate must be a non-negative number");
      payload.rateAmount = amt;
    } else {
      const pct = parseFloat(form.ratePercent);
      if (isNaN(pct) || pct < 0 || pct > 100)
        return toast.error("Rate percent must be between 0 and 100");
      payload.ratePercent = pct;
    }

    // Per-product overrides (validate each has a product)
    const seen = new Set<string>();
    const productRules: Record<string, unknown>[] = [];
    for (const o of form.overrides) {
      if (!o.productId) return toast.error("Each override must pick a test/product");
      if (seen.has(o.productId)) return toast.error("Duplicate product in overrides");
      seen.add(o.productId);
      const rule: Record<string, unknown> = { productId: o.productId, rateType: o.rateType };
      if (o.rateType === "FIXED_AMOUNT") rule.rateAmount = parseFloat(o.rateAmount) || 0;
      else rule.ratePercent = parseFloat(o.ratePercent) || 0;
      if (o.reduceDoctor) {
        rule.reducedReferralCommissionType = o.reducedType;
        if (o.reducedType === "FIXED_AMOUNT")
          rule.reducedReferralCommissionAmount = parseFloat(o.reducedAmount) || 0;
        else rule.reducedReferralCommissionPercent = parseFloat(o.reducedPercent) || 0;
      }
      productRules.push(rule);
    }
    payload.productRules = productRules;

    saveMutation.mutate({ editingId, payload });
  };

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1100 }}>
        <OwnerPageHeader
          title="Payouts · Outside Labs & rates"
          subtitle="Vendor labs we send tests to. Set the rate we pay each; these drive the lab payables."
          rightSlot={
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/owner/payouts")}
                style={{ color: TOKENS.info, fontSize: 13 }}
              >
                View lab payables →
              </button>
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" /> Add lab
              </Button>
            </div>
          }
        />

        {isLoading ? (
          <FullPageSkeleton rows={4} />
        ) : labs.length === 0 ? (
          <SectionCard>
            <EmptyState
              icon={FlaskConical}
              label="No outside labs yet"
              hint="Vendor labs you send tests to. The rate you set here becomes a lab payable each time a biller outsources a test at billing."
            />
            <div className="mt-3 flex justify-center">
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" /> Add your first lab
              </Button>
            </div>
          </SectionCard>
        ) : (
          <SectionCard padding={0}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lab #</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Default rate</TableHead>
                <TableHead>Overrides</TableHead>
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
                    {lab.productRules?.length ? `${lab.productRules.length} test(s)` : "—"}
                  </TableCell>
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
                      {lab.isActive && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteId(lab.id)}
                          aria-label="Deactivate lab"
                          title="Deactivate lab"
                        >
                          <Archive className="h-4 w-4 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </div>

      {/* Create / Edit */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!o) resetForm(); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
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

            {/* Per-product overrides */}
            <div className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label>Per-test overrides</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((f) => ({
                      ...f,
                      overrides: [
                        ...f.overrides,
                        {
                          productId: "",
                          rateType: "PERCENTAGE",
                          ratePercent: "0",
                          rateAmount: "0",
                          reduceDoctor: false,
                          reducedType: "PERCENTAGE",
                          reducedPercent: "0",
                          reducedAmount: "0",
                        },
                      ],
                    }))
                  }
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add override
                </Button>
              </div>
              {form.overrides.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Optional. Each lab uses its default rate unless a test is overridden here. Set a
                  reduced referring-doctor commission per test if needed.
                </p>
              ) : (
                form.overrides.map((o, idx) => (
                  <div key={idx} className="space-y-2 rounded-md border bg-muted/20 p-2">
                    <div className="flex items-center gap-2">
                      <select
                        className="h-9 flex-1 rounded-md border bg-white px-2 text-sm"
                        value={o.productId}
                        onChange={(e) => setOverride(idx, { productId: e.target.value })}
                      >
                        <option value="">Select test / product…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() =>
                          setForm((f) => ({ ...f, overrides: f.overrides.filter((_, i) => i !== idx) }))
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Lab rate</span>
                      <select
                        className="h-8 rounded-md border bg-white px-2"
                        value={o.rateType}
                        onChange={(e) => setOverride(idx, { rateType: e.target.value as ReferralPayoutType })}
                      >
                        <option value="PERCENTAGE">%</option>
                        <option value="FIXED_AMOUNT">Flat ₹</option>
                      </select>
                      {o.rateType === "FIXED_AMOUNT" ? (
                        <Input
                          type="number"
                          className="h-8 w-24"
                          min={0}
                          value={o.rateAmount}
                          onChange={(e) => setOverride(idx, { rateAmount: e.target.value })}
                        />
                      ) : (
                        <Input
                          type="number"
                          className="h-8 w-20"
                          min={0}
                          max={100}
                          value={o.ratePercent}
                          onChange={(e) => setOverride(idx, { ratePercent: e.target.value })}
                        />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <label className="flex items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={o.reduceDoctor}
                          onChange={(e) => setOverride(idx, { reduceDoctor: e.target.checked })}
                        />
                        <span className="text-muted-foreground">Reduce doctor commission</span>
                      </label>
                      {o.reduceDoctor && (
                        <>
                          <select
                            className="h-8 rounded-md border bg-white px-2"
                            value={o.reducedType}
                            onChange={(e) =>
                              setOverride(idx, { reducedType: e.target.value as ReferralPayoutType })
                            }
                          >
                            <option value="PERCENTAGE">%</option>
                            <option value="FIXED_AMOUNT">Flat ₹</option>
                          </select>
                          {o.reducedType === "FIXED_AMOUNT" ? (
                            <Input
                              type="number"
                              className="h-8 w-24"
                              min={0}
                              value={o.reducedAmount}
                              onChange={(e) => setOverride(idx, { reducedAmount: e.target.value })}
                            />
                          ) : (
                            <Input
                              type="number"
                              className="h-8 w-20"
                              min={0}
                              max={100}
                              value={o.reducedPercent}
                              onChange={(e) => setOverride(idx, { reducedPercent: e.target.value })}
                            />
                          )}
                        </>
                      )}
                    </div>
                    {o.productId && (
                      <p className="text-xs text-muted-foreground">{productName(o.productId)}</p>
                    )}
                  </div>
                ))
              )}
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
            >
              {deleteMutation.isPending ? "Deactivating…" : "Deactivate"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

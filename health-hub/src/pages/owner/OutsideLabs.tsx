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
import { FlaskConical, Plus, Pencil, X } from "lucide-react";
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
import type {
  Partner,
  PartnerArrangementKind,
  PartnerDoctorCommissionMode,
  PartnerRateBasis,
} from "@/types";

interface ProductLite {
  id: string;
  name: string;
  code: string;
}

/** One row of a partner's rate card. */
interface RuleRow {
  productId: string;
  rateBasis: PartnerRateBasis;
  ratePercent: string;
  rateAmount: string;
}

interface ArrangementForm {
  enabled: boolean;
  rateBasis: PartnerRateBasis;
  ratePercent: string;
  rateAmount: string;
  doctorCommissionMode: PartnerDoctorCommissionMode;
  rules: RuleRow[];
}

const KINDS: { kind: PartnerArrangementKind; label: string; hint: string }[] = [
  {
    kind: "INBOUND_BILLED_THERE",
    label: "They send patients · they bill",
    hint: "They collect from the patient and owe us our share.",
  },
  {
    kind: "INBOUND_BILLED_HERE",
    label: "They send patients · we bill",
    hint: "We collect at our counter and owe them their cut.",
  },
  {
    kind: "OUTBOUND_VENDOR",
    label: "We send work to them",
    hint: "We collect at our counter and owe them a vendor rate.",
  },
];

const DOCTOR_MODES: { value: PartnerDoctorCommissionMode; label: string }[] = [
  { value: "OUR_SHARE", label: "Off our share" },
  { value: "NONE", label: "No doctor commission" },
  { value: "GROSS", label: "Off the full price" },
];

const emptyArrangement = (): ArrangementForm => ({
  enabled: false,
  rateBasis: "PCT_OF_OUR_PRICE",
  ratePercent: "100",
  rateAmount: "0",
  doctorCommissionMode: "OUR_SHARE",
  rules: [],
});

const EMPTY_FORM = {
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  address: "",
  sendBill: false,
  sendReport: true,
  arrangements: Object.fromEntries(
    KINDS.map((k) => [k.kind, emptyArrangement()]),
  ) as Record<PartnerArrangementKind, ArrangementForm>,
};

/** A rate always reads as what WE keep, so the label says so explicitly. */
function rateLabel(basis: PartnerRateBasis, percent: number | null, amountInPaise: number | null) {
  if (basis === "FLAT") return `${formatRupees(amountInPaise ?? 0)} / test to us`;
  const of = basis === "PCT_OF_PARTNER_BILLED" ? "their bill" : "our price";
  return `${percent ?? 0}% of ${of} to us`;
}

function summarise(partner: Partner): string {
  const active = partner.arrangements.filter((a) => a.isActive);
  if (!active.length) return "—";
  return active
    .map((a) => {
      const k = KINDS.find((x) => x.kind === a.kind);
      const rules = a.productRules?.length ? ` · ${a.productRules.length} test rate(s)` : "";
      return `${k?.label ?? a.kind}: ${rateLabel(a.rateBasis, a.ratePercent, a.rateAmountInPaise)}${rules}`;
    })
    .join("  ·  ");
}

export default function OutsideLabs() {
  const navigate = useNavigate();
  const branchId = useBranchId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const { data: partners = [], isLoading } = useApiQuery<Partner[]>({
    branchScoped: true,
    // "all" keeps this off the active-only key New Visit reads — same key +
    // different URL meant whichever page loaded first served the other one.
    queryKey: [...qk.externalLabs(branchId), "all"],
    queryFn: () => branchRequest<Partner[]>("/partners?includeInactive=true", branchId!),
  });

  const { data: products = [] } = useApiQuery<ProductLite[]>({
    branchScoped: true,
    // Same list New Visit downloads — share its key so a price edit refreshes both.
    queryKey: qk.billableProducts(branchId),
    queryFn: () => branchRequest<ProductLite[]>("/billable-products", branchId!),
  });
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  const saveMutation = useApiMutation<
    Partner,
    { editingId: string | null; payload: Record<string, unknown> }
  >({
    mutationFn: ({ editingId, payload }) =>
      branchRequest<Partner>(editingId ? `/partners/${editingId}` : "/partners", branchId!, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: (_d, { editingId }) => {
      toast.success(editingId ? "Partner updated" : "Partner created");
      resetForm();
    },
    onError: (err) => toast.error(err.message || "Failed to save partner"),
  });

  const toggleMutation = useApiMutation<Partner, Partner>({
    mutationFn: (partner) =>
      branchRequest<Partner>(`/partners/${partner.id}`, branchId!, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !partner.isActive }),
      }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: (_d, p) => toast.success(`Partner ${!p.isActive ? "activated" : "deactivated"}`),
    onError: (err) => toast.error(err.message || "Failed to update status"),
  });

  const deleteMutation = useApiMutation<void, string>({
    mutationFn: (id) => branchRequest<void>(`/partners/${id}`, branchId!, { method: "DELETE" }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: () => toast.success("Partner deactivated"),
    onError: (err) => toast.error(err.message || "Failed to delete partner"),
    onSettled: () => setDeleteId(null),
  });

  const resetForm = () => {
    setForm({
      ...EMPTY_FORM,
      arrangements: Object.fromEntries(
        KINDS.map((k) => [k.kind, emptyArrangement()]),
      ) as Record<PartnerArrangementKind, ArrangementForm>,
    });
    setDialogOpen(false);
    setEditingId(null);
  };

  const handleAdd = () => {
    resetForm();
    setDialogOpen(true);
  };

  const handleEdit = (partner: Partner) => {
    const arrangements = Object.fromEntries(
      KINDS.map((k) => {
        const a = partner.arrangements.find((x) => x.kind === k.kind);
        if (!a) return [k.kind, emptyArrangement()];
        return [
          k.kind,
          {
            enabled: a.isActive,
            rateBasis: a.rateBasis,
            ratePercent: String(a.ratePercent ?? 0),
            rateAmount: String((a.rateAmountInPaise ?? 0) / 100),
            doctorCommissionMode: a.doctorCommissionMode,
            rules: (a.productRules ?? []).map((r) => ({
              productId: r.productId!,
              rateBasis: r.rateBasis,
              ratePercent: String(r.ratePercent ?? 0),
              rateAmount: String((r.rateAmountInPaise ?? 0) / 100),
            })),
          } as ArrangementForm,
        ];
      }),
    ) as Record<PartnerArrangementKind, ArrangementForm>;

    setForm({
      name: partner.name,
      contactPerson: partner.contactPerson || "",
      phone: partner.phone || "",
      email: partner.email || "",
      address: partner.address || "",
      sendBill: partner.sendBill,
      sendReport: partner.sendReport,
      arrangements,
    });
    setEditingId(partner.id);
    setDialogOpen(true);
  };

  const patchArrangement = (kind: PartnerArrangementKind, patch: Partial<ArrangementForm>) =>
    setForm((f) => ({
      ...f,
      arrangements: { ...f.arrangements, [kind]: { ...f.arrangements[kind], ...patch } },
    }));

  const handleSave = () => {
    if (!form.name.trim()) {
      toast.error("Partner name is required");
      return;
    }
    const arrangements = KINDS.filter((k) => form.arrangements[k.kind].enabled).map((k) => {
      const a = form.arrangements[k.kind];
      return {
        kind: k.kind,
        rateBasis: a.rateBasis,
        ratePercent: Number(a.ratePercent || 0),
        rateAmount: Number(a.rateAmount || 0),
        doctorCommissionMode: a.doctorCommissionMode,
        productRules: a.rules
          .filter((r) => r.productId)
          .map((r) => ({
            productId: r.productId,
            rateBasis: r.rateBasis,
            ratePercent: Number(r.ratePercent || 0),
            rateAmount: Number(r.rateAmount || 0),
          })),
      };
    });
    if (!arrangements.length) {
      toast.error("Turn on at least one arrangement — that is what a partner IS.");
      return;
    }
    saveMutation.mutate({
      editingId,
      payload: {
        name: form.name,
        contactPerson: form.contactPerson,
        phone: form.phone,
        email: form.email,
        address: form.address,
        sendBill: form.sendBill,
        sendReport: form.sendReport,
        arrangements,
      },
    });
  };

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1100 }}>
        <OwnerPageHeader
          title="Payouts · Outside Labs & rates"
          subtitle="Labs and centres we work with, both directions. A rate here always means what WE keep."
          rightSlot={
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/owner/payouts")}
                style={{ color: TOKENS.info, fontSize: 13 }}
              >
                View partner settlements →
              </button>
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" /> Add partner
              </Button>
            </div>
          }
        />

        {isLoading ? (
          <FullPageSkeleton rows={4} />
        ) : partners.length === 0 ? (
          <SectionCard>
            <EmptyState
              icon={FlaskConical}
              label="No partners yet"
              hint="A lab or hospital you exchange work with. Set what you keep per test, and it is frozen onto every order billed from then on."
            />
            <div className="mt-3 flex justify-center">
              <Button onClick={handleAdd}>
                <Plus className="mr-2 h-4 w-4" /> Add your first partner
              </Button>
            </div>
          </SectionCard>
        ) : (
          <SectionCard padding={0}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Partner #</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Arrangements &amp; rates</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead className="text-center">Bill</TableHead>
                  <TableHead className="text-center">Report</TableHead>
                  <TableHead className="text-center">Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partners.map((partner) => (
                  <TableRow key={partner.id} className={!partner.isActive ? "opacity-50" : ""}>
                    <TableCell className="font-mono">{partner.partnerNumber}</TableCell>
                    <TableCell className="font-medium">{partner.name}</TableCell>
                    <TableCell className="text-muted-foreground" style={{ fontSize: 12 }}>
                      {summarise(partner)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {partner.contactPerson || partner.phone || "---"}
                    </TableCell>
                    <TableCell className="text-center text-muted-foreground">
                      {partner.sendBill ? "Sent" : "Held"}
                    </TableCell>
                    <TableCell className="text-center text-muted-foreground">
                      {partner.sendReport ? "Sent" : "Held"}
                    </TableCell>
                    <TableCell className="text-center">
                      <Switch
                        checked={partner.isActive}
                        onCheckedChange={() => toggleMutation.mutate(partner)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(partner)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteId(partner.id)}>
                        <X className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? setDialogOpen(true) : resetForm())}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[760px]">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit partner" : "Add partner"}</DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Lalitha Hospital"
              />
            </div>
            <div>
              <Label>Contact person</Label>
              <Input
                value={form.contactPerson}
                onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
              />
            </div>
            <div>
              <Label>Phone</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch
                checked={form.sendBill}
                onCheckedChange={(v) => setForm({ ...form, sendBill: v })}
              />
              <Label className="font-normal">Send our bill to the patient</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.sendReport}
                onCheckedChange={(v) => setForm({ ...form, sendReport: v })}
              />
              <Label className="font-normal">Send the report to the patient</Label>
            </div>
          </div>
          <p className="text-muted-foreground" style={{ fontSize: 12 }}>
            With the bill held, the bill WhatsApp and its link are closed and counter print is
            greyed — an owner can still print with a reason, and it is logged.
          </p>

          {KINDS.map((k) => {
            const a = form.arrangements[k.kind];
            return (
              <div
                key={k.kind}
                className="mt-3 rounded-md p-3"
                style={{ border: `0.5px solid ${TOKENS.border}` }}
              >
                <div className="flex items-center gap-2">
                  <Switch
                    checked={a.enabled}
                    onCheckedChange={(v) => patchArrangement(k.kind, { enabled: v })}
                  />
                  <Label className="font-medium">{k.label}</Label>
                </div>
                <p className="mt-1 text-muted-foreground" style={{ fontSize: 12 }}>
                  {k.hint}
                </p>

                {a.enabled && (
                  <>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <div>
                        <Label>We keep</Label>
                        <Select
                          value={a.rateBasis}
                          onValueChange={(v) =>
                            patchArrangement(k.kind, { rateBasis: v as PartnerRateBasis })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PCT_OF_OUR_PRICE">% of our price</SelectItem>
                            <SelectItem value="PCT_OF_PARTNER_BILLED">% of their bill</SelectItem>
                            <SelectItem value="FLAT">A flat amount per test</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>{a.rateBasis === "FLAT" ? "Amount (₹)" : "Percent"}</Label>
                        {a.rateBasis === "FLAT" ? (
                          <Input
                            value={a.rateAmount}
                            onChange={(e) =>
                              patchArrangement(k.kind, { rateAmount: e.target.value })
                            }
                          />
                        ) : (
                          <Input
                            value={a.ratePercent}
                            onChange={(e) =>
                              patchArrangement(k.kind, { ratePercent: e.target.value })
                            }
                          />
                        )}
                      </div>
                      <div>
                        <Label>Referring doctor paid</Label>
                        <Select
                          value={a.doctorCommissionMode}
                          onValueChange={(v) =>
                            patchArrangement(k.kind, {
                              doctorCommissionMode: v as PartnerDoctorCommissionMode,
                            })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DOCTOR_MODES.map((m) => (
                              <SelectItem key={m.value} value={m.value}>
                                {m.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between">
                      <Label>Per-test rates</Label>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          patchArrangement(k.kind, {
                            rules: [
                              ...a.rules,
                              {
                                productId: "",
                                rateBasis: "FLAT",
                                ratePercent: "0",
                                rateAmount: "0",
                              },
                            ],
                          })
                        }
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add test
                      </Button>
                    </div>
                    <p className="text-muted-foreground" style={{ fontSize: 12 }}>
                      A named test beats the rate above. Most lab cards are flat per test — a CBP at
                      ₹60 and a culture at ₹100 are not the same percentage.
                    </p>

                    {a.rules.map((rule, i) => (
                      <div key={i} className="mt-2 grid grid-cols-12 items-end gap-2">
                        <div className="col-span-5">
                          <Select
                            value={rule.productId}
                            onValueChange={(v) => {
                              const rules = [...a.rules];
                              rules[i] = { ...rules[i], productId: v };
                              patchArrangement(k.kind, { rules });
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select test" />
                            </SelectTrigger>
                            <SelectContent>
                              {products.map((p) => (
                                <SelectItem key={p.id} value={p.id}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Select
                            value={rule.rateBasis}
                            onValueChange={(v) => {
                              const rules = [...a.rules];
                              rules[i] = { ...rules[i], rateBasis: v as PartnerRateBasis };
                              patchArrangement(k.kind, { rules });
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="FLAT">Flat ₹</SelectItem>
                              <SelectItem value="PCT_OF_OUR_PRICE">% our price</SelectItem>
                              <SelectItem value="PCT_OF_PARTNER_BILLED">% their bill</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Input
                            value={rule.rateBasis === "FLAT" ? rule.rateAmount : rule.ratePercent}
                            onChange={(e) => {
                              const rules = [...a.rules];
                              rules[i] =
                                rule.rateBasis === "FLAT"
                                  ? { ...rules[i], rateAmount: e.target.value }
                                  : { ...rules[i], ratePercent: e.target.value };
                              patchArrangement(k.kind, { rules });
                            }}
                          />
                        </div>
                        <div className="col-span-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              patchArrangement(k.kind, {
                                rules: a.rules.filter((_, idx) => idx !== i),
                              })
                            }
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}

          <DialogFooter>
            <Button variant="outline" onClick={resetForm}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {editingId ? "Save changes" : "Create partner"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this partner?</AlertDialogTitle>
            <AlertDialogDescription>
              Bills already raised keep the share frozen on them — nothing recorded changes. The
              partner simply stops being selectable on new visits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteId && deleteMutation.mutate(deleteId)}>
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

/**
 * Outside Labs — the partner CONFIGURATION screen.
 *
 * Rates, arrangements and the two patient-facing doors live here. Nothing is
 * settled here: money is read and paid in Pay-Run, which this screen links to.
 *
 * Built in the Pay-Run vocabulary on purpose — SectionCard, tinted collapsible
 * group headers, 11-13px type, hairline section rules — because the first
 * version used raw shadcn tables with tall rows and read as a different product.
 */
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { useApiQuery, useApiMutation, branchRequest, useBranchId, qk } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronDown, FlaskConical, Pencil, Plus, Printer, X } from "lucide-react";
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

interface ProductLite { id: string; name: string; code: string }

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

/** The deal, asked in words. Enum names never reach the screen. */
const KINDS: {
  kind: PartnerArrangementKind;
  label: string;
  hint: string;
  example?: string;
  inbound: boolean;
}[] = [
  {
    kind: "INBOUND_BILLED_THERE",
    label: "They send patients, they bill",
    hint: "They collect from the patient and owe us our share.",
    example: "Lalitha Hospital",
    inbound: true,
  },
  {
    kind: "INBOUND_BILLED_HERE",
    label: "They send patients, we bill",
    hint: "We collect at the counter and owe them their cut.",
    inbound: true,
  },
  {
    kind: "OUTBOUND_VENDOR",
    label: "We send them work",
    hint: "We collect at the counter and owe them a vendor rate.",
    inbound: false,
  },
];

const DOCTOR_MODES: { value: PartnerDoctorCommissionMode; label: string; hint: string }[] = [
  { value: "OUR_SHARE", label: "Off our share", hint: "30% of what we kept, never more." },
  { value: "NONE", label: "Not paid at all", hint: "The partner IS the referrer." },
  { value: "GROSS", label: "Off the full price", hint: "As if it were a walk-in." },
];

const emptyArrangement = (): ArrangementForm => ({
  enabled: false,
  rateBasis: "PCT_OF_OUR_PRICE",
  ratePercent: "100",
  rateAmount: "0",
  doctorCommissionMode: "OUR_SHARE",
  rules: [],
});
const blankArrangements = () =>
  Object.fromEntries(KINDS.map((k) => [k.kind, emptyArrangement()])) as Record<
    PartnerArrangementKind,
    ArrangementForm
  >;
const EMPTY_FORM = {
  name: "",
  contactPerson: "",
  phone: "",
  sendBill: false,
  sendReport: true,
  arrangements: blankArrangements(),
};

const STEPS = ["Who", "The deal", "Rates", "Patient doors"] as const;

/** A rate always reads as what WE keep — stated, so it can never be entered inverted. */
function rateLabel(basis: PartnerRateBasis, pct: number | null, amt: number | null) {
  if (basis === "FLAT") return `${formatRupees(amt ?? 0)} / test`;
  return `${pct ?? 0}% of ${basis === "PCT_OF_PARTNER_BILLED" ? "their bill" : "our price"}`;
}

export default function OutsideLabs() {
  const navigate = useNavigate();
  const branchId = useBranchId();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({ ...EMPTY_FORM, arrangements: blankArrangements() });

  const { data: partners = [], isLoading } = useApiQuery<Partner[]>({
    branchScoped: true,
    queryKey: [...qk.externalLabs(branchId), "all"],
    queryFn: () => branchRequest<Partner[]>("/partners?includeInactive=true", branchId!),
  });
  const { data: products = [] } = useApiQuery<ProductLite[]>({
    branchScoped: true,
    queryKey: qk.billableProducts(branchId),
    queryFn: () => branchRequest<ProductLite[]>("/billable-products", branchId!),
  });
  const productName = (id: string) => products.find((p) => p.id === id)?.name ?? id;

  // Split by direction, the way Pay-Run splits by payee type.
  const { inbound, outbound } = useMemo(() => {
    const inb: Partner[] = [];
    const out: Partner[] = [];
    for (const p of partners) {
      const kinds = p.arrangements.filter((a) => a.isActive).map((a) => a.kind);
      if (kinds.some((k) => k !== "OUTBOUND_VENDOR")) inb.push(p);
      if (kinds.includes("OUTBOUND_VENDOR")) out.push(p);
      if (kinds.length === 0) inb.push(p);
    }
    return { inbound: inb, outbound: out };
  }, [partners]);

  const sumIn = inbound.reduce((s, p) => s + (p.period?.theyOweUsInPaise ?? 0), 0);
  const sumOut = outbound.reduce((s, p) => s + (p.period?.weOweThemInPaise ?? 0), 0);

  const save = useApiMutation<Partner, { editingId: string | null; payload: Record<string, unknown> }>({
    mutationFn: ({ editingId, payload }) =>
      branchRequest<Partner>(editingId ? `/partners/${editingId}` : "/partners", branchId!, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: (_d, v) => {
      toast.success(v.editingId ? "Partner updated" : "Partner created");
      reset();
    },
    onError: (e) => toast.error(e.message || "Failed to save partner"),
  });
  const toggleActive = useApiMutation<Partner, Partner>({
    mutationFn: (p) =>
      branchRequest<Partner>(`/partners/${p.id}`, branchId!, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !p.isActive }),
      }),
    invalidate: [qk.externalLabs(branchId)],
    onError: (e) => toast.error(e.message || "Failed to update status"),
  });
  const remove = useApiMutation<void, string>({
    mutationFn: (id) => branchRequest<void>(`/partners/${id}`, branchId!, { method: "DELETE" }),
    invalidate: [qk.externalLabs(branchId)],
    onSuccess: () => toast.success("Partner deactivated"),
    onSettled: () => setDeleteId(null),
  });

  const reset = () => {
    setForm({ ...EMPTY_FORM, arrangements: blankArrangements() });
    setDialogOpen(false);
    setEditingId(null);
    setStep(0);
  };
  const add = () => {
    reset();
    setDialogOpen(true);
  };
  const edit = (p: Partner) => {
    const arrangements = Object.fromEntries(
      KINDS.map((k) => {
        const a = p.arrangements.find((x) => x.kind === k.kind);
        return [
          k.kind,
          a
            ? ({
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
              } as ArrangementForm)
            : emptyArrangement(),
        ];
      }),
    ) as Record<PartnerArrangementKind, ArrangementForm>;
    setForm({
      name: p.name,
      contactPerson: p.contactPerson || "",
      phone: p.phone || "",
      sendBill: p.sendBill,
      sendReport: p.sendReport,
      arrangements,
    });
    setEditingId(p.id);
    setStep(0);
    setDialogOpen(true);
  };

  const patch = (k: PartnerArrangementKind, v: Partial<ArrangementForm>) =>
    setForm((f) => ({ ...f, arrangements: { ...f.arrangements, [k]: { ...f.arrangements[k], ...v } } }));
  const chosen = KINDS.filter((k) => form.arrangements[k.kind].enabled);

  const submit = () => {
    if (!form.name.trim()) return toast.error("Partner name is required");
    if (!chosen.length) return toast.error("Pick what the arrangement is — that is what a partner IS.");
    save.mutate({
      editingId,
      payload: {
        name: form.name,
        contactPerson: form.contactPerson,
        phone: form.phone,
        sendBill: form.sendBill,
        sendReport: form.sendReport,
        arrangements: chosen.map((k) => {
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
        }),
      },
    });
  };

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const renderGroup = (
    title: string,
    rows: Partner[],
    out: boolean,
    subtitle: React.ReactNode,
  ) => (
    <div className="mb-3">
      {out && (
        <div
          className="mb-1.5 mt-3 flex items-center gap-2 font-medium uppercase"
          style={{ fontSize: 11, letterSpacing: "0.05em", color: TOKENS.caution }}
        >
          <span style={{ flex: 1, height: 1, background: "#e0cfa3" }} />
          {title}
          <span style={{ flex: 1, height: 1, background: "#e0cfa3" }} />
        </div>
      )}
      <SectionCard padding={0}>
        <div
          className="flex items-center gap-3 px-3 py-2"
          style={{
            background: out ? "#fbf7ee" : "#f6f5f2",
            borderTopLeftRadius: 12,
            borderTopRightRadius: 12,
          }}
        >
          <span className="font-medium" style={{ fontSize: 12 }}>
            {out ? "Outbound" : title}
          </span>
          <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>{subtitle}</span>
        </div>
        {rows.length === 0 ? (
          <div className="px-3 py-4" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
            None yet.
          </div>
        ) : (
          <table className="w-full">
            <tbody>
              {rows.map((p) => {
                const deal = p.arrangements.find((a) =>
                  out ? a.kind === "OUTBOUND_VENDOR" : a.kind !== "OUTBOUND_VENDOR",
                );
                const rules = deal?.productRules ?? [];
                const money = out ? (p.period?.weOweThemInPaise ?? 0) : (p.period?.theyOweUsInPaise ?? 0);
                const rowKey = p.id + (out ? ":o" : ":i");
                const open = expanded.has(rowKey);
                return (
                  <Fragment key={rowKey}>
                    <tr style={{ borderTop: `0.5px solid ${TOKENS.border}`, opacity: p.isActive ? 1 : 0.5 }}>
                      <td className="py-2 pl-3" style={{ width: 26 }}>
                        <button onClick={() => toggleExpand(rowKey)}>
                          <ChevronDown
                            className="h-3.5 w-3.5 transition-transform"
                            style={{ transform: open ? "none" : "rotate(-90deg)", color: TOKENS.textTertiary }}
                          />
                        </button>
                      </td>
                      <td className="py-2" style={{ width: 92, fontSize: 12, color: TOKENS.textSecondary }}>
                        {p.partnerNumber}
                      </td>
                      <td className="py-2 font-medium">{p.name}</td>
                      <td className="py-2" style={{ fontSize: 12, color: TOKENS.textSecondary }}>
                        {rules.length > 0
                          ? rules.slice(0, 3).map((r, i) => (
                              <span key={r.id}>
                                {i > 0 && " · "}
                                {r.product?.code ?? "—"}{" "}
                                <span style={{ color: TOKENS.textPrimary, fontWeight: 600 }}>
                                  {r.rateBasis === "FLAT"
                                    ? formatRupees(r.rateAmountInPaise ?? 0)
                                    : `${r.ratePercent}%`}
                                </span>
                              </span>
                            ))
                          : deal
                            ? rateLabel(deal.rateBasis, deal.ratePercent, deal.rateAmountInPaise)
                            : "—"}
                        {rules.length > 3 && (
                          <span style={{ color: TOKENS.textTertiary }}> +{rules.length - 3}</span>
                        )}
                      </td>
                      <td className="py-2" style={{ width: 120, fontSize: 11 }}>
                        {!p.sendBill && (
                          <span
                            style={{
                              border: `1px solid ${TOKENS.border}`,
                              borderRadius: 4,
                              padding: "1px 5px",
                              color: TOKENS.textTertiary,
                            }}
                          >
                            bill held
                          </span>
                        )}
                      </td>
                      <td
                        className="py-2 text-right font-medium tabular-nums"
                        style={{ width: 110, color: out ? TOKENS.caution : TOKENS.healthy }}
                      >
                        {money ? formatRupees(money) : <span style={{ color: TOKENS.textTertiary }}>—</span>}
                      </td>
                      <td className="py-2 pr-3 text-right" style={{ width: 110 }}>
                        <Switch
                          className="mr-2 align-middle"
                          checked={p.isActive}
                          onCheckedChange={() => toggleActive.mutate(p)}
                        />
                        <button className="mr-1 align-middle" onClick={() => edit(p)}>
                          <Pencil className="h-3.5 w-3.5" style={{ color: TOKENS.textTertiary }} />
                        </button>
                        <button className="align-middle" onClick={() => setDeleteId(p.id)}>
                          <X className="h-3.5 w-3.5" style={{ color: TOKENS.textTertiary }} />
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ background: "#fcfcfb" }}>
                        <td colSpan={7} className="px-3 py-3">
                          <div style={{ fontSize: 12, color: TOKENS.textSecondary, marginBottom: 6 }}>
                            {KINDS.find((k) => k.kind === deal?.kind)?.hint}
                          </div>
                          {rules.length > 0 && (
                            <table className="w-full" style={{ maxWidth: 460 }}>
                              <tbody>
                                {rules.map((r) => (
                                  <tr key={r.id}>
                                    <td style={{ fontSize: 12, padding: "2px 0" }}>
                                      {r.product?.name ?? productName(r.productId!)}
                                    </td>
                                    <td
                                      className="text-right font-medium tabular-nums"
                                      style={{ fontSize: 12, padding: "2px 0" }}
                                    >
                                      {r.rateBasis === "FLAT"
                                        ? formatRupees(r.rateAmountInPaise ?? 0)
                                        : `${r.ratePercent}%`}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <button
                            className="mt-2"
                            style={{ color: TOKENS.info, fontSize: 12 }}
                            onClick={() => navigate("/owner/payouts")}
                          >
                            <Printer className="mr-1 inline h-3 w-3" />
                            Statement in Pay-Run →
                          </button>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>
    </div>
  );

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1100 }}>
        <OwnerPageHeader
          title="Payouts · Outside Labs"
          subtitle="Who we exchange work with. A rate always means what we keep — settle in Pay-Run."
          rightSlot={
            <div className="flex items-center gap-3">
              <button onClick={() => navigate("/owner/payouts")} style={{ color: TOKENS.info, fontSize: 13 }}>
                Pay-Run →
              </button>
              <Button onClick={add}>
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
              hint="When a lab or hospital sends you work, what you keep is often not what the patient was charged. Add one and every bill from then on records your share."
            />
            <div className="mt-3 flex justify-center">
              <Button onClick={add}>
                <Plus className="mr-2 h-4 w-4" /> Add your first partner
              </Button>
            </div>
          </SectionCard>
        ) : (
          <>
            {renderGroup(
              "They send us patients",
              inbound,
              false,
              <>
                {inbound.length} {inbound.length === 1 ? "partner" : "partners"}
                {sumIn > 0 && (
                  <>
                    {" · they owe us "}
                    <span className="font-medium" style={{ color: TOKENS.healthy }}>
                      {formatRupees(sumIn)}
                    </span>
                  </>
                )}
              </>,
            )}
            {renderGroup(
              "We send them work",
              outbound,
              true,
              <>
                {outbound.length} {outbound.length === 1 ? "partner" : "partners"}
                {sumOut > 0 && (
                  <>
                    {" · we owe "}
                    <span className="font-medium" style={{ color: TOKENS.caution }}>
                      {formatRupees(sumOut)}
                    </span>
                  </>
                )}
              </>,
            )}
          </>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? setDialogOpen(true) : reset())}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[640px]">
          <DialogHeader>
            <DialogTitle style={{ fontSize: 16 }}>
              {editingId ? "Edit partner" : "Add partner"}
            </DialogTitle>
          </DialogHeader>

          {/* Stepped: one question per screen. The first version put three
              arrangements, three bases, a doctor mode and a rate card on one
              scroll, which is why it read as a wall. */}
          <div className="flex" style={{ borderBottom: `0.5px solid ${TOKENS.border}` }}>
            {STEPS.map((label, i) => (
              <button
                key={label}
                onClick={() => setStep(i)}
                className="px-3 py-2"
                style={{
                  fontSize: 12,
                  color: i === step ? TOKENS.textPrimary : TOKENS.textTertiary,
                  fontWeight: i === step ? 600 : 400,
                  borderBottom: `2px solid ${i === step ? TOKENS.textPrimary : "transparent"}`,
                }}
              >
                <span
                  className="mr-1.5 inline-block text-center"
                  style={{
                    width: 16,
                    height: 16,
                    lineHeight: "16px",
                    borderRadius: 99,
                    fontSize: 10,
                    fontWeight: 600,
                    background: i === step ? TOKENS.textPrimary : "#eceae5",
                    color: i === step ? "#fff" : TOKENS.textSecondary,
                  }}
                >
                  {i + 1}
                </span>
                {label}
              </button>
            ))}
          </div>

          <div className="pt-1">
            {step === 0 && (
              <>
                <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                  NAME
                </label>
                <Input
                  autoFocus
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Lalitha Hospital"
                />
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                      CONTACT
                    </label>
                    <Input
                      value={form.contactPerson}
                      onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                      PHONE
                    </label>
                    <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                </div>
              </>
            )}

            {step === 1 && (
              <div className="flex flex-col gap-2">
                {KINDS.map((k) => {
                  const on = form.arrangements[k.kind].enabled;
                  return (
                    <button
                      key={k.kind}
                      onClick={() => patch(k.kind, { enabled: !on })}
                      className="rounded-lg px-3 py-2.5 text-left"
                      style={{
                        border: `0.5px solid ${on ? TOKENS.borderStrong : TOKENS.border}`,
                        background: on ? "#fbfbf9" : "#fff",
                      }}
                    >
                      <div style={{ fontWeight: on ? 600 : 400 }}>{k.label}</div>
                      <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                        {k.hint}
                        {k.example && <em> {k.example}.</em>}
                      </div>
                    </button>
                  );
                })}
                <div
                  className="mt-1 rounded-r px-3 py-2"
                  style={{ borderLeft: `2px solid #e0cfa3`, background: "#fcfaf5", fontSize: 12, color: TOKENS.textSecondary }}
                >
                  A partner can have more than one. Most have one.
                </div>
              </div>
            )}

            {step === 2 && (
              <>
                {chosen.length === 0 && (
                  <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>Pick an arrangement first.</div>
                )}
                {chosen.map((k) => {
                  const a = form.arrangements[k.kind];
                  return (
                    <div key={k.kind} className="mb-4">
                      <div className="mb-2 font-medium" style={{ fontSize: 12 }}>
                        {k.label}
                      </div>
                      <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                        WHAT WE KEEP, PER TEST
                      </label>
                      {a.rules.map((r, i) => (
                        <div key={i} className="mb-1.5 grid grid-cols-12 gap-2">
                          <div className="col-span-6">
                            <Select
                              value={r.productId}
                              onValueChange={(v) => {
                                const rules = [...a.rules];
                                rules[i] = { ...rules[i], productId: v };
                                patch(k.kind, { rules });
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue placeholder="Select test" />
                              </SelectTrigger>
                              <SelectContent>
                                {products.map((pr) => (
                                  <SelectItem key={pr.id} value={pr.id}>
                                    {pr.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-3">
                            <Select
                              value={r.rateBasis}
                              onValueChange={(v) => {
                                const rules = [...a.rules];
                                rules[i] = { ...rules[i], rateBasis: v as PartnerRateBasis };
                                patch(k.kind, { rules });
                              }}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="FLAT">Flat ₹</SelectItem>
                                <SelectItem value="PCT_OF_OUR_PRICE">% our price</SelectItem>
                                <SelectItem value="PCT_OF_PARTNER_BILLED">% their bill</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="col-span-2">
                            <Input
                              className="h-8"
                              value={r.rateBasis === "FLAT" ? r.rateAmount : r.ratePercent}
                              onChange={(e) => {
                                const rules = [...a.rules];
                                rules[i] =
                                  r.rateBasis === "FLAT"
                                    ? { ...rules[i], rateAmount: e.target.value }
                                    : { ...rules[i], ratePercent: e.target.value };
                                patch(k.kind, { rules });
                              }}
                            />
                          </div>
                          <button
                            className="col-span-1"
                            onClick={() => patch(k.kind, { rules: a.rules.filter((_, x) => x !== i) })}
                          >
                            <X className="h-3.5 w-3.5" style={{ color: TOKENS.textTertiary }} />
                          </button>
                        </div>
                      ))}
                      <button
                        style={{ color: TOKENS.info, fontSize: 12 }}
                        onClick={() =>
                          patch(k.kind, {
                            rules: [
                              ...a.rules,
                              { productId: "", rateBasis: "FLAT", ratePercent: "0", rateAmount: "0" },
                            ],
                          })
                        }
                      >
                        + Add test
                      </button>

                      <div className="mt-3 flex items-center gap-2" style={{ fontSize: 12 }}>
                        <span style={{ color: TOKENS.textSecondary }}>Anything not listed</span>
                        <Select
                          value={a.rateBasis}
                          onValueChange={(v) => patch(k.kind, { rateBasis: v as PartnerRateBasis })}
                        >
                          <SelectTrigger className="h-7 w-[150px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="PCT_OF_OUR_PRICE">% of our price</SelectItem>
                            <SelectItem value="PCT_OF_PARTNER_BILLED">% of their bill</SelectItem>
                            <SelectItem value="FLAT">Flat ₹</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          className="h-7 w-[80px]"
                          value={a.rateBasis === "FLAT" ? a.rateAmount : a.ratePercent}
                          onChange={(e) =>
                            patch(
                              k.kind,
                              a.rateBasis === "FLAT"
                                ? { rateAmount: e.target.value }
                                : { ratePercent: e.target.value },
                            )
                          }
                        />
                        <span style={{ color: TOKENS.textTertiary }}>to us</span>
                      </div>

                      <div className="mt-3" style={{ fontSize: 12 }}>
                        <span style={{ color: TOKENS.textSecondary }}>Referring doctor is </span>
                        <Select
                          value={a.doctorCommissionMode}
                          onValueChange={(v) =>
                            patch(k.kind, { doctorCommissionMode: v as PartnerDoctorCommissionMode })
                          }
                        >
                          <SelectTrigger className="mt-1 h-7 w-[220px]">
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
                        <div style={{ color: TOKENS.textTertiary, marginTop: 2 }}>
                          {DOCTOR_MODES.find((m) => m.value === a.doctorCommissionMode)?.hint}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div
                  className="rounded-r px-3 py-2"
                  style={{ borderLeft: "2px solid #bcdcd0", background: "#f6fbf9", fontSize: 12, color: TOKENS.textSecondary }}
                >
                  A real lab card is flat per test — a CBP at ₹60 and a culture at ₹100 are not the same
                  percentage.
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <div className="flex items-start gap-3 py-1.5">
                  <Switch checked={form.sendBill} onCheckedChange={(v) => setForm({ ...form, sendBill: v })} />
                  <div>
                    <div>Send our bill to the patient</div>
                    <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                      Off: the bill WhatsApp and its link stay shut, and counter print greys.
                    </div>
                  </div>
                </div>
                <div className="flex items-start gap-3 py-1.5">
                  <Switch checked={form.sendReport} onCheckedChange={(v) => setForm({ ...form, sendReport: v })} />
                  <div>
                    <div>Send the report to the patient</div>
                    <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                      On: they still get their result from us.
                    </div>
                  </div>
                </div>
                {form.arrangements.INBOUND_BILLED_THERE.enabled && form.sendBill && (
                  <div
                    className="mt-2 rounded-r px-3 py-2"
                    style={{ borderLeft: "2px solid #e3b3b3", background: "#fdf6f6", fontSize: 12, color: TOKENS.textSecondary }}
                  >
                    They bill the patient themselves. Leaving our bill on hands the patient a second one
                    for the same test.
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter>
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button onClick={() => setStep(step + 1)}>Next · {STEPS[step + 1]}</Button>
            ) : (
              <Button onClick={submit} disabled={save.isPending}>
                {editingId ? "Save changes" : "Create partner"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate this partner?</AlertDialogTitle>
            <AlertDialogDescription>
              Bills already raised keep their frozen share — nothing recorded changes. The partner just
              stops being selectable on new visits.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteId && remove.mutate(deleteId)}>
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
}

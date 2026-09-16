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
import { useReferralCategories } from "@/lib/payoutCategories";
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
/** A category rung row. Blank value = inherit the arrangement's default. */
interface CatRow {
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
  cats: Record<string, CatRow>;
}

/** The deal, asked in words. Enum names never reach the screen. */
const KINDS: {
  kind: PartnerArrangementKind;
  label: string;
  hint: string;
  /** Where the patient's money goes. The only thing that really separates these. */
  flow: string;
  /** Which way the settlement points, and therefore which colour it wears. */
  settle: "they owe us" | "we owe them";
  example?: string;
  inbound: boolean;
}[] = [
  {
    kind: "INBOUND_BILLED_THERE",
    label: "They send patients, they bill",
    hint: "They collect from the patient and owe us our share.",
    flow: "patient → them → us",
    settle: "they owe us",
    example: "Lalitha",
    inbound: true,
  },
  {
    kind: "INBOUND_BILLED_HERE",
    label: "They send patients, we bill",
    hint: "We collect at the counter and keep our share.",
    flow: "patient → us → them",
    settle: "we owe them",
    inbound: true,
  },
  {
    kind: "OUTBOUND_VENDOR",
    label: "We send them work",
    hint: "We collect at the counter and pay them a vendor rate.",
    flow: "patient → us → them",
    settle: "we owe them",
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
  cats: {},
});

const blankCat = (): CatRow => ({ rateBasis: "PCT_OF_OUR_PRICE", ratePercent: "", rateAmount: "" });
/** A rung is set only when its value box has something in it. */
const catFilled = (c?: CatRow) =>
  !!c && (c.rateBasis === "FLAT" ? c.rateAmount !== "" : c.ratePercent !== "");
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
  const categories = useReferralCategories();
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
                cats: Object.fromEntries(
                  (a.categoryRules ?? []).map((r) => [
                    r.category!,
                    {
                      rateBasis: r.rateBasis,
                      ratePercent: r.rateBasis === "FLAT" ? "" : String(r.ratePercent ?? ""),
                      rateAmount: r.rateBasis === "FLAT" ? String((r.rateAmountInPaise ?? 0) / 100) : "",
                    },
                  ]),
                ),
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
            // Only categories the owner actually typed a value into become
            // rules; a blank row means "inherit", not "zero".
            categoryRules: Object.entries(a.cats)
              .filter(([, c]) => catFilled(c))
              .map(([category, c]) => ({
                category,
                rateBasis: c.rateBasis,
                ratePercent: Number(c.ratePercent || 0),
                rateAmount: Number(c.rateAmount || 0),
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

  /**
   * One row = one partner under one direction. Laid out as a flex line rather
   * than a fixed-column table: with only a handful of columns, fixed widths left
   * voids that made the row read as scattered islands instead of a sentence.
   * The rate card takes the slack, because it is the part that varies.
   */
  const partnerRow = (p: Partner, out: boolean) => {
    const deal = p.arrangements.find((a) =>
      out ? a.kind === "OUTBOUND_VENDOR" : a.kind !== "OUTBOUND_VENDOR",
    );
    const rules = deal?.productRules ?? [];
    const cats = deal?.categoryRules ?? [];
    const rowKey = p.id + (out ? ":o" : ":i");
    const open = expanded.has(rowKey);
    return (
      <Fragment key={rowKey}>
        <div
          className="flex items-center gap-3 px-3 py-2"
          style={{ borderTop: `0.5px solid ${TOKENS.border}`, opacity: p.isActive ? 1 : 0.45 }}
        >
          <button onClick={() => toggleExpand(rowKey)} className="shrink-0">
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform"
              style={{ transform: open ? "none" : "rotate(-90deg)", color: TOKENS.textTertiary }}
            />
          </button>
          <span
            className="shrink-0 tabular-nums"
            style={{ fontSize: 11.5, color: TOKENS.textTertiary }}
          >
            {p.partnerNumber}
          </span>
          <span className="shrink-0 font-medium" style={{ fontSize: 13 }}>
            {p.name}
          </span>
          <span
            className="min-w-0 flex-1 truncate"
            style={{ fontSize: 12, color: TOKENS.textSecondary }}
          >
            {rules.length > 0 ? (
              rules.slice(0, 4).map((r, i) => (
                <span key={r.id}>
                  {i > 0 && <span style={{ color: TOKENS.textTertiary }}> · </span>}
                  {r.product?.code ?? "?"}{" "}
                  <span style={{ color: TOKENS.textPrimary, fontWeight: 600 }}>
                    {r.rateBasis === "FLAT" ? formatRupees(r.rateAmountInPaise ?? 0) : `${r.ratePercent}%`}
                  </span>
                </span>
              ))
            ) : deal ? (
              rateLabel(deal.rateBasis, deal.ratePercent, deal.rateAmountInPaise)
            ) : null}
            {rules.length > 4 && (
              <span style={{ color: TOKENS.textTertiary }}> +{rules.length - 4}</span>
            )}
            {cats.length > 0 && (
              <span style={{ color: TOKENS.textTertiary }}>
                {" "}
                · {cats.length} category
              </span>
            )}
          </span>
          {!p.sendBill && (
            <span
              className="shrink-0"
              style={{
                fontSize: 10.5,
                border: `0.5px solid ${TOKENS.border}`,
                borderRadius: 4,
                padding: "1px 5px",
                color: TOKENS.textTertiary,
              }}
            >
              bill held
            </span>
          )}
          <div className="flex shrink-0 items-center gap-2">
            <Switch checked={p.isActive} onCheckedChange={() => toggleActive.mutate(p)} />
            <button onClick={() => edit(p)} title="Edit">
              <Pencil className="h-3.5 w-3.5" style={{ color: TOKENS.textTertiary }} />
            </button>
            <button onClick={() => setDeleteId(p.id)} title="Deactivate">
              <X className="h-3.5 w-3.5" style={{ color: TOKENS.textTertiary }} />
            </button>
          </div>
        </div>

        {open && (
          <div
            className="px-3 py-3"
            style={{ borderTop: `0.5px solid ${TOKENS.border}`, background: "#fcfcfb" }}
          >
            <div style={{ fontSize: 12, color: TOKENS.textSecondary, marginBottom: 8 }}>
              {KINDS.find((k) => k.kind === deal?.kind)?.hint}
            </div>
            {(rules.length > 0 || cats.length > 0) && (
              <div style={{ maxWidth: 380 }}>
                {cats.map((r) => (
                  <div key={r.id} className="flex justify-between" style={{ fontSize: 12, padding: "2px 0" }}>
                    <span style={{ color: TOKENS.textSecondary }}>{r.category}</span>
                    <span className="font-medium tabular-nums">
                      {r.rateBasis === "FLAT" ? formatRupees(r.rateAmountInPaise ?? 0) : `${r.ratePercent}%`}
                    </span>
                  </div>
                ))}
                {rules.map((r) => (
                  <div key={r.id} className="flex justify-between" style={{ fontSize: 12, padding: "2px 0" }}>
                    <span>{r.product?.name ?? productName(r.productId!)}</span>
                    <span className="font-medium tabular-nums">
                      {r.rateBasis === "FLAT" ? formatRupees(r.rateAmountInPaise ?? 0) : `${r.ratePercent}%`}
                    </span>
                  </div>
                ))}
                <div
                  className="mt-1 flex justify-between"
                  style={{ fontSize: 12, borderTop: `0.5px solid ${TOKENS.border}`, paddingTop: 4, color: TOKENS.textTertiary }}
                >
                  <span>Anything else</span>
                  <span className="tabular-nums">
                    {deal ? rateLabel(deal.rateBasis, deal.ratePercent, deal.rateAmountInPaise) : "—"}
                  </span>
                </div>
              </div>
            )}
            {/* Pay-Run's statement route is /owner/payouts/:id where id is
                "<payeeType>.<payeeId>" — land on THIS partner, not the list. */}
            <button
              className="mt-2.5"
              style={{ color: TOKENS.info, fontSize: 12 }}
              onClick={() => navigate(`/owner/payouts/PARTNER.${p.id}`)}
            >
              <Printer className="mr-1 inline h-3 w-3" />
              {p.name}'s statement in Pay-Run →
            </button>
          </div>
        )}
      </Fragment>
    );
  };

  /** Both directions live in ONE card, split by a tinted bar — an empty section
   *  gets a single quiet line rather than its own card, rule and empty state. */
  const directions = (
    <SectionCard padding={0}>
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: "#f6f5f2", borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
      >
        <span className="font-medium" style={{ fontSize: 12 }}>
          They send us patients
        </span>
        <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>
          {inbound.length || "none"}
        </span>
      </div>
      {inbound.length === 0 ? (
        <div className="px-3 py-2.5" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
          No inbound partners yet.
        </div>
      ) : (
        inbound.map((p) => partnerRow(p, false))
      )}

      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: "#fbf7ee", borderTop: `0.5px solid ${TOKENS.border}` }}
      >
        <span className="font-medium" style={{ fontSize: 12, color: TOKENS.caution }}>
          We send them work
        </span>
        <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>
          {outbound.length || "none"}
        </span>
      </div>
      {outbound.length === 0 ? (
        <div className="px-3 py-2.5" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
          Nothing sent out. Add an outbound arrangement on a partner when you start.
        </div>
      ) : (
        outbound.map((p) => partnerRow(p, true))
      )}
    </SectionCard>
  );

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1100 }}>
        <OwnerPageHeader
          title="Payouts · Outside Labs"
          subtitle="Who we exchange work with, and what we keep. No money is settled here — Pay-Run owns the period."
          rightSlot={
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate("/owner/payouts?type=PARTNER")}
                style={{ color: TOKENS.info, fontSize: 13 }}
              >
                Partner settlements →
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
          directions
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => (o ? setDialogOpen(true) : reset())}>
        <DialogContent
          className="max-h-[86vh] gap-0 overflow-y-auto p-0 sm:max-w-[560px]"
          style={{ background: TOKENS.surface }}
        >
          <DialogHeader
            className="px-4 py-2.5"
            style={{ background: "#f6f5f2", borderBottom: `0.5px solid ${TOKENS.border}` }}
          >
            <DialogTitle
              className="font-medium uppercase"
              style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.textSecondary }}
            >
              {editingId ? "Edit partner" : "New partner"}
            </DialogTitle>
          </DialogHeader>

          {/* Stepped: one question per screen. The first version put three
              arrangements, three bases, a doctor mode and a rate card on one
              scroll, which is why it read as a wall. */}
          <div className="flex px-4" style={{ borderBottom: `0.5px solid ${TOKENS.border}` }}>
            {STEPS.map((label, i) => (
              <button
                key={label}
                onClick={() => setStep(i)}
                className="py-2 pr-5 font-medium uppercase"
                style={{
                  fontSize: 10.5,
                  letterSpacing: "0.06em",
                  color: i === step ? TOKENS.textPrimary : TOKENS.textTertiary,
                  borderBottom: `1.5px solid ${i === step ? TOKENS.textPrimary : "transparent"}`,
                  marginBottom: -1,
                }}
              >
                {i + 1} · {label}
              </button>
            ))}
          </div>

          <div className="px-4 py-3.5">
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
                      <div
                        className="mb-2 rounded-r px-3 py-1.5"
                        style={{ borderLeft: `2px solid ${TOKENS.border}`, background: "#fafaf8", fontSize: 11.5, color: TOKENS.textTertiary }}
                      >
                        Most specific wins: <b style={{ color: TOKENS.textSecondary }}>a named test</b> beats{" "}
                        <b style={{ color: TOKENS.textSecondary }}>its category</b>, which beats{" "}
                        <b style={{ color: TOKENS.textSecondary }}>the catch-all</b>.
                      </div>

                      <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                        BY CATEGORY
                      </label>
                      <div className="mb-3">
                        {categories.map((cat) => {
                          const c = a.cats[cat] ?? blankCat();
                          const set = catFilled(c);
                          const patchCat = (v: Partial<CatRow>) =>
                            patch(k.kind, { cats: { ...a.cats, [cat]: { ...c, ...v } } });
                          return (
                            <div key={cat} className="mb-1 grid grid-cols-12 items-center gap-2">
                              <div
                                className="col-span-5"
                                style={{ fontSize: 12.5, color: set ? TOKENS.textPrimary : TOKENS.textSecondary }}
                              >
                                {cat}
                              </div>
                              <div className="col-span-4">
                                <Select
                                  value={c.rateBasis}
                                  onValueChange={(v) => patchCat({ rateBasis: v as PartnerRateBasis })}
                                >
                                  <SelectTrigger className="h-7" style={{ fontSize: 12 }}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="PCT_OF_OUR_PRICE">% our price</SelectItem>
                                    <SelectItem value="PCT_OF_PARTNER_BILLED">% their bill</SelectItem>
                                    <SelectItem value="FLAT">Flat ₹</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="col-span-3">
                                <Input
                                  className="h-7"
                                  style={{ fontSize: 12 }}
                                  /* Blank means inherit the catch-all — the placeholder
                                     shows what it would inherit, so an empty box is
                                     never mistaken for a zero rate. */
                                  placeholder={
                                    a.rateBasis === "FLAT" ? a.rateAmount || "0" : `${a.ratePercent || "0"}%`
                                  }
                                  value={c.rateBasis === "FLAT" ? c.rateAmount : c.ratePercent}
                                  onChange={(e) =>
                                    patchCat(
                                      c.rateBasis === "FLAT"
                                        ? { rateAmount: e.target.value }
                                        : { ratePercent: e.target.value },
                                    )
                                  }
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <label className="mb-1 block" style={{ fontSize: 11, fontWeight: 600, color: TOKENS.textSecondary }}>
                        BY TEST <span style={{ fontWeight: 400, color: TOKENS.textTertiary }}>· overrides its category</span>
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

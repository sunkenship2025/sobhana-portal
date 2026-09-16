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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ChevronDown, FlaskConical, Pencil, Plus, Printer, Trash2, X } from "lucide-react";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The deeper rate rungs stay folded away until asked for.
  const [ratesOpen, setRatesOpen] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState("partner");
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
    setTab("partner");
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
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => toggleExpand(rowKey)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            <ChevronDown
              className="h-4 w-4 transition-transform"
              style={{ transform: open ? "none" : "rotate(-90deg)", color: TOKENS.textTertiary }}
            />
          </Button>
          <span className="shrink-0 tabular-nums text-xs" style={{ color: TOKENS.textTertiary }}>
            {p.partnerNumber}
          </span>
          {/* The stored name is upper-case data; the column should not shout it
              back. Rendered in sentence case, title-cased for display only. */}
          <span className="shrink-0 font-medium capitalize">{p.name.toLowerCase()}</span>
          <span className="min-w-0 flex-1 truncate text-sm" style={{ color: TOKENS.textSecondary }}>
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
            <Badge variant="secondary" className="shrink-0 font-normal">
              Bill held
            </Badge>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <Switch
              className="mr-1"
              checked={p.isActive}
              onCheckedChange={() => toggleActive.mutate(p)}
              aria-label={p.isActive ? "Deactivate" : "Activate"}
            />
            <Button variant="ghost" size="icon" onClick={() => edit(p)} aria-label="Edit partner">
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDeleteId(p.id)}
              aria-label="Deactivate partner"
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>

        {open && (
          <div
            className="px-3 py-3"
            style={{ borderTop: `0.5px solid ${TOKENS.border}`, background: "#fcfcfb" }}
          >
            <div className="mb-2 text-sm" style={{ color: TOKENS.textSecondary }}>
              {KINDS.find((k) => k.kind === deal?.kind)?.hint}
            </div>
            {(rules.length > 0 || cats.length > 0) && (
              <div style={{ maxWidth: 380 }}>
                {cats.map((r) => (
                  <div key={r.id} className="flex items-center justify-between py-0.5 text-sm">
                    <span className="flex items-center gap-2" style={{ color: TOKENS.textSecondary }}>
                      {r.category}
                      {/* Badged, because "Laboratory 20%" and "CBP ₹60" otherwise
                          look like the same kind of rule when one overrides the other. */}
                      <Badge variant="secondary" className="font-normal">
                        category
                      </Badge>
                    </span>
                    <span className="font-medium tabular-nums">
                      {r.rateBasis === "FLAT" ? formatRupees(r.rateAmountInPaise ?? 0) : `${r.ratePercent}%`}
                    </span>
                  </div>
                ))}
                {rules.map((r) => (
                  <div key={r.id} className="flex items-center justify-between py-0.5 text-sm">
                    <span className="capitalize">
                      {(r.product?.name ?? productName(r.productId!)).toLowerCase()}
                    </span>
                    <span className="font-medium tabular-nums">
                      {r.rateBasis === "FLAT" ? formatRupees(r.rateAmountInPaise ?? 0) : `${r.ratePercent}%`}
                    </span>
                  </div>
                ))}
                <div
                  className="mt-1 flex justify-between pt-1 text-sm"
                  style={{ borderTop: `0.5px solid ${TOKENS.border}`, color: TOKENS.textTertiary }}
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
            <Button
              variant="outline"
              size="sm"
              className="mt-2.5 h-7 px-2"
              onClick={() => navigate(`/owner/payouts/PARTNER.${p.id}`)}
            >
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              Statement in Pay-Run
            </Button>
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
        <span className="text-sm font-semibold">They send us patients</span>
        <span className="text-sm" style={{ color: TOKENS.textTertiary }}>
          {inbound.length || "none"}
        </span>
      </div>
      {inbound.length === 0 ? (
        <div className="px-3 py-2.5 text-sm" style={{ color: TOKENS.textTertiary }}>
          No inbound partners yet.
        </div>
      ) : (
        inbound.map((p) => partnerRow(p, false))
      )}

      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: "#fbf7ee", borderTop: `0.5px solid ${TOKENS.border}` }}
      >
        <span className="text-sm font-semibold" style={{ color: TOKENS.caution }}>
          We send them work
        </span>
        <span className="text-sm" style={{ color: TOKENS.textTertiary }}>
          {outbound.length || "none"}
        </span>
      </div>
      {outbound.length === 0 ? (
        <div className="px-3 py-2.5 text-sm" style={{ color: TOKENS.textTertiary }}>
          Nothing sent out. Add an outbound arrangement on a partner when you start.
        </div>
      ) : (
        outbound.map((p) => partnerRow(p, true))
      )}
    </SectionCard>
  );

  return (
    <AppLayout context="owner" subContext="payouts">
      {/* 1440 + pb-24 is what Pay-Run and Money use — at 1100 this page was
          visibly narrower than every sibling and left a dead gutter on the right. */}
      <div style={{ maxWidth: 1440 }} className="pb-24">
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
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit partner" : "Add partner"}</DialogTitle>
          </DialogHeader>

          {/* Tabs for organisation, NOT a wizard: Save works from any of them,
              so there is no Next/Back and no near-empty first step. Identity and
              the patient doors share a tab so none of the three is thin. */}
          <Tabs value={tab} onValueChange={setTab} className="pt-2">
            <TabsList>
              <TabsTrigger value="partner">Partner</TabsTrigger>
              <TabsTrigger value="deal">Deal</TabsTrigger>
              <TabsTrigger value="rates">Rates</TabsTrigger>
            </TabsList>

            <TabsContent value="partner" className="space-y-5 pt-4 focus-visible:ring-0 focus-visible:ring-offset-0">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  autoFocus={!editingId}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Lalitha Hospital"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Contact person</Label>
                  <Input
                    value={form.contactPerson}
                    onChange={(e) => setForm({ ...form, contactPerson: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
            </div>

              <Separator />

              <div className="space-y-1">
                  <div className="flex items-start gap-3 py-2">
                    <Switch
                      className="mt-0.5"
                      checked={form.sendBill}
                      onCheckedChange={(v) => setForm({ ...form, sendBill: v })}
                    />
                    <div>
                      <Label className="block">Send our bill to the patient</Label>
                      <p className="mt-0.5 text-sm" style={{ color: TOKENS.textTertiary }}>
                        Off: the bill WhatsApp, its link and counter print all stay shut.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 py-2">
                    <Switch
                      className="mt-0.5"
                      checked={form.sendReport}
                      onCheckedChange={(v) => setForm({ ...form, sendReport: v })}
                    />
                    <div>
                      <Label className="block">Send the report to the patient</Label>
                      <p className="mt-0.5 text-sm" style={{ color: TOKENS.textTertiary }}>
                        On: they still get their result from us.
                      </p>
                    </div>
                  </div>
                  {form.arrangements.INBOUND_BILLED_THERE.enabled && form.sendBill && (
                    <div
                      className="mt-2 rounded-md border px-3 py-2.5 text-sm"
                      style={{ borderColor: "#e9d9d9", background: "#fdf7f7", color: TOKENS.textSecondary }}
                    >
                      They bill the patient themselves. Leaving our bill on hands the patient a second one
                      for the same test.
                    </div>
                  )}
              </div>

            </TabsContent>


            <TabsContent value="deal" className="space-y-3 pt-4 focus-visible:ring-0 focus-visible:ring-offset-0">
                <Label className="mb-2 block">What is the arrangement?</Label>
                {/* Multi-select in substance (a partner can hold several), but each
                    row needs a real indicator — the previous version was clickable
                    divs with nothing showing which was chosen. */}
                <div className="flex flex-col gap-2">
                  {KINDS.map((k) => {
                    const on = form.arrangements[k.kind].enabled;
                    return (
                      <button
                        key={k.kind}
                        type="button"
                        onClick={() => patch(k.kind, { enabled: !on })}
                        className="flex items-start gap-3 rounded-md border px-3 py-3 text-left"
                        style={{
                          borderColor: on ? TOKENS.textPrimary : "hsl(var(--input))",
                          background: on ? "#fbfbf9" : "#fff",
                        }}
                      >
                        <Checkbox checked={on} className="mt-0.5" tabIndex={-1} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{k.label}</span>
                          {/* Only the chosen row explains itself — three hints at
                              once was three sentences to read before choosing. */}
                          {on && (
                            <span className="block text-sm" style={{ color: TOKENS.textTertiary }}>
                              {k.hint}
                            </span>
                          )}
                        </span>
                        <span
                          className="shrink-0 whitespace-nowrap text-xs tabular-nums"
                          style={{ color: TOKENS.textTertiary }}
                        >
                          {k.flow}
                        </span>
                      </button>
                    );
                  })}
                </div>


            </TabsContent>

            <TabsContent value="rates" className="space-y-4 pt-4 focus-visible:ring-0 focus-visible:ring-offset-0">
              {chosen.length === 0 ? (
                <p className="text-sm" style={{ color: TOKENS.textTertiary }}>
                  Pick an arrangement on the Deal tab first — rates belong to a deal.
                </p>
              ) : (
              <>

                {chosen.length === 0 && (
                  <div style={{ fontSize: 12, color: TOKENS.textTertiary }}>Pick an arrangement first.</div>
                )}
                {chosen.map((k) => {
                  const a = form.arrangements[k.kind];
                  return (
                    <div key={k.kind} className="space-y-3">
                      <Label>
                        What we keep
                        {chosen.length > 1 && (
                          <span className="font-normal" style={{ color: TOKENS.textTertiary }}>
                            {" · "}
                            {k.label.toLowerCase()}
                          </span>
                        )}
                      </Label>

                      {/* Per-test first. It is the only rung most partners use and
                          the only one anyone edits monthly; categories, the
                          catch-all and the doctor rule sit behind disclosure so the
                          default form stays short. */}
                      {a.rules.map((r, i) => (
                        <div key={i} className="grid grid-cols-12 gap-2">
                          <div className="col-span-6">
                            <Select
                              value={r.productId}
                              onValueChange={(v) => {
                                const rules = [...a.rules];
                                rules[i] = { ...rules[i], productId: v };
                                patch(k.kind, { rules });
                              }}
                            >
                              <SelectTrigger className="h-9">
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
                              <SelectTrigger className="h-9">
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
                              className="h-9 text-right"
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="col-span-1 h-9 w-9"
                            aria-label="Remove test rate"
                            onClick={() => patch(k.kind, { rules: a.rules.filter((_, x) => x !== i) })}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          patch(k.kind, {
                            rules: [
                              ...a.rules,
                              { productId: "", rateBasis: "FLAT", ratePercent: "0", rateAmount: "0" },
                            ],
                          })
                        }
                      >
                        <Plus className="mr-1.5 h-3.5 w-3.5" />
                        Add test
                      </Button>

                      <Collapsible
                        open={!!ratesOpen[k.kind]}
                        onOpenChange={(o) => setRatesOpen((r) => ({ ...r, [k.kind]: o }))}
                      >
                        <CollapsibleTrigger asChild>
                          <Button variant="ghost" size="sm" className="-ml-2 px-2">
                            <ChevronDown
                              className="mr-1 h-4 w-4 transition-transform"
                              style={{ transform: ratesOpen[k.kind] ? "none" : "rotate(-90deg)" }}
                            />
                            Rates by category, and everything else
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent className="space-y-4 pt-3">
                          <p className="text-sm" style={{ color: TOKENS.textTertiary }}>
                            A named test above beats its category, which beats the catch-all.
                          </p>

                          <div className="space-y-1.5">
                            {categories.map((cat) => {
                              const c = a.cats[cat] ?? blankCat();
                              const patchCat = (v: Partial<CatRow>) =>
                                patch(k.kind, { cats: { ...a.cats, [cat]: { ...c, ...v } } });
                              return (
                                <div key={cat} className="grid grid-cols-12 items-center gap-2">
                                  <div
                                    className="col-span-6 text-sm"
                                    style={{
                                      color: catFilled(c) ? TOKENS.textPrimary : TOKENS.textTertiary,
                                    }}
                                  >
                                    {cat}
                                  </div>
                                  <div className="col-span-4">
                                    <Select
                                      value={c.rateBasis}
                                      onValueChange={(v) => patchCat({ rateBasis: v as PartnerRateBasis })}
                                    >
                                      <SelectTrigger className="h-8">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="PCT_OF_OUR_PRICE">% our price</SelectItem>
                                        <SelectItem value="PCT_OF_PARTNER_BILLED">% their bill</SelectItem>
                                        <SelectItem value="FLAT">Flat ₹</SelectItem>
                                      </SelectContent>
                                    </Select>
                                  </div>
                                  <div className="col-span-2">
                                    <Input
                                      className="h-8 text-right"
                                      /* Blank inherits the catch-all; the placeholder
                                         shows what it would inherit, so an empty box
                                         is never read as a zero rate. */
                                      placeholder={
                                        a.rateBasis === "FLAT" ? a.rateAmount || "0" : a.ratePercent || "0"
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

                          <div className="flex items-center gap-2 text-sm">
                            <span style={{ color: TOKENS.textSecondary }}>Anything not listed</span>
                            <Select
                              value={a.rateBasis}
                              onValueChange={(v) => patch(k.kind, { rateBasis: v as PartnerRateBasis })}
                            >
                              <SelectTrigger className="h-8 w-[150px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="PCT_OF_OUR_PRICE">% of our price</SelectItem>
                                <SelectItem value="PCT_OF_PARTNER_BILLED">% of their bill</SelectItem>
                                <SelectItem value="FLAT">Flat ₹</SelectItem>
                              </SelectContent>
                            </Select>
                            <Input
                              className="h-8 w-[80px] text-right"
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

                          {/* A rate always means what WE keep. On an outbound deal
                              the owner is thinking "I pay them 60%", so echo the
                              consequence — it is one keystroke from inverted. */}
                          {k.kind === "OUTBOUND_VENDOR" && a.rateBasis !== "FLAT" && (
                            <p className="text-sm" style={{ color: TOKENS.caution }}>
                              On a ₹1,000 test we keep ₹
                              {Math.round((Number(a.ratePercent || 0) * 1000) / 100)} and pay them ₹
                              {1000 - Math.round((Number(a.ratePercent || 0) * 1000) / 100)}. If that is
                              the wrong way round, enter {100 - Number(a.ratePercent || 0)}.
                            </p>
                          )}

                          <div className="space-y-2">
                            <Label>Referring doctor is</Label>
                            <Select
                              value={a.doctorCommissionMode}
                              onValueChange={(v) =>
                                patch(k.kind, { doctorCommissionMode: v as PartnerDoctorCommissionMode })
                              }
                            >
                              <SelectTrigger className="h-9 w-[240px]">
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
                            <p className="text-sm" style={{ color: TOKENS.textTertiary }}>
                              {DOCTOR_MODES.find((m) => m.value === a.doctorCommissionMode)?.hint}
                            </p>
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
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

            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="outline" onClick={reset}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
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

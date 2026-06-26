import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { API_BASE, API_BASE_URL } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Printer,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { formatRupees } from "@/lib/payoutFormatters";
import {
  OwnerPageHeader,
  SectionCard,
  DisplayNumber,
  MiniBar,
  TOKENS,
  EmptyState,
  FullPageSkeleton,
  RefreshButton,
} from "./_shared/ownerUi";
import {
  PayRunWorklist,
  PayoutWorklistRow,
  PaymentType,
  PayoutDoctorType,
} from "@/types";
import { PayoutBulkActionBar } from "@/components/payouts/PayoutBulkActionBar";
import { PayoutMarkPaidDialog, type PayoutMarkPaidPayment } from "@/components/payouts/PayoutMarkPaidDialog";
import { PayoutDeleteDialog } from "@/components/payouts/PayoutDeleteDialog";

type TypeFilter = "all" | PayoutDoctorType;

const TYPE_ORDER: PayoutDoctorType[] = ["REFERRAL", "DIAGNOSTIC_CENTER", "CLINIC", "LAB"];
const TYPE_LABEL: Record<PayoutDoctorType, string> = {
  REFERRAL: "Referral Doctors",
  DIAGNOSTIC_CENTER: "Clinic Referrals",
  CLINIC: "Consulting Doctors",
  LAB: "Outside Labs",
};
const TYPE_BADGE: Record<PayoutDoctorType, string> = {
  REFERRAL: "REF",
  DIAGNOSTIC_CENTER: "CLINIC",
  CLINIC: "CONSULT",
  LAB: "LAB",
};
const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "REFERRAL", label: "Ref Dr" },
  { key: "DIAGNOSTIC_CENTER", label: "Clinic" },
  { key: "CLINIC", label: "Consult" },
  { key: "LAB", label: "Lab" },
];

// ── date helpers ────────────────────────────────────────────────────────────
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function monthRange(d: Date) {
  return {
    start: ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
    end: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}
function last30(): { start: string; end: string } {
  const e = new Date();
  const s = new Date();
  s.setDate(s.getDate() - 29);
  return { start: ymd(s), end: ymd(e) };
}
function quarterRange(): { start: string; end: string } {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3);
  return {
    start: ymd(new Date(now.getFullYear(), q * 3, 1)),
    end: ymd(new Date(now.getFullYear(), q * 3 + 3, 0)),
  };
}
function fyRange(): { start: string; end: string; label: string } {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // India FY Apr–Mar
  return {
    start: ymd(new Date(y, 3, 1)),
    end: ymd(new Date(y + 1, 2, 31)),
    label: `FY ${y}–${String(y + 1).slice(2)}`,
  };
}

type CustomPeriod = { start: string; end: string; label: string } | null;

export default function PayoutsList() {
  const { token, user } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isOwner = user?.role === "owner";

  // All filters are seeded from the URL so the view is shareable/bookmarkable and
  // survives a round-trip into a statement and back (Back to Pay-Run uses history).
  // Period: a month stepper by default; "custom" overrides with a preset / range.
  const [monthDate, setMonthDate] = useState(() => {
    const m = searchParams.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      const [y, mo] = m.split("-").map(Number);
      return new Date(y, mo - 1, 1);
    }
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth() - 1, 1); // last completed month
  });
  const [custom, setCustom] = useState<CustomPeriod>(() => {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (from && to) return { start: from, end: to, label: searchParams.get("plabel") || `${from} → ${to}` };
    return null;
  });
  const [periodOpen, setPeriodOpen] = useState(false);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");

  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => {
    const t = searchParams.get("type");
    if (t && (t === "all" || (TYPE_ORDER as string[]).includes(t))) return t as TypeFilter;
    return "all";
  });
  const [status, setStatus] = useState<"all" | "pending" | "paid">(() => {
    const s = searchParams.get("status");
    return s === "all" || s === "paid" || s === "pending" ? s : "pending";
  });
  const [view, setView] = useState<"grouped" | "flat">(() =>
    searchParams.get("view") === "flat" ? "flat" : "grouped"
  );
  const [collapsed, setCollapsed] = useState<Set<PayoutDoctorType>>(new Set());
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");
  const [q, setQ] = useState(() => searchParams.get("q") ?? "");
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Mirror the active filters into the URL (replace, so it doesn't spam history).
  useEffect(() => {
    const p = new URLSearchParams();
    if (status !== "pending") p.set("status", status);
    if (typeFilter !== "all") p.set("type", typeFilter);
    if (view !== "grouped") p.set("view", view);
    if (custom) {
      p.set("from", custom.start);
      p.set("to", custom.end);
      if (custom.label) p.set("plabel", custom.label);
    } else {
      p.set("month", `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`);
    }
    if (q) p.set("q", q);
    setSearchParams(p, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, typeFilter, view, custom, monthDate, q]);

  const range = useMemo(
    () => (custom ? { start: custom.start, end: custom.end } : monthRange(monthDate)),
    [custom, monthDate]
  );
  const monthLabel = monthDate.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const periodLabel = custom ? custom.label : monthLabel;

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": activeBranchId ?? "",
    "Content-Type": "application/json",
  });

  const [worklist, setWorklist] = useState<PayRunWorklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchWorklist = async () => {
    if (!token || !activeBranchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("startDate", range.start);
      params.set("endDate", range.end + "T23:59:59.999Z");
      if (status !== "all") params.set("status", status);
      if (typeFilter !== "all") params.set("payeeType", typeFilter);
      if (q) params.set("q", q);
      params.set("view", view);
      const res = await fetch(`${API_BASE}/payouts/worklist?${params.toString()}`, {
        headers: headers(),
      });
      if (!res.ok) {
        toast.error("Failed to load payouts");
        return;
      }
      const body = await res.json();
      setWorklist(body.data as PayRunWorklist);
    } catch (err) {
      console.error(err);
      toast.error("Error loading payouts");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorklist();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeBranchId, range.start, range.end, status, typeFilter, q, view]);

  const rows = worklist?.rows ?? [];
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedTotalInPaise = selectedRows.reduce((s, r) => s + r.amountInPaise, 0);

  const groups = useMemo(() => {
    const g = worklist?.groups ?? [];
    return [...g].sort(
      (a, b) => TYPE_ORDER.indexOf(a.payeeType) - TYPE_ORDER.indexOf(b.payeeType)
    );
  }, [worklist]);

  // On the Paid view, show most-recently-paid first.
  const sortForDisplay = (rs: PayoutWorklistRow[]) =>
    status === "paid"
      ? [...rs].sort((a, b) => (b.paidAt ? +new Date(b.paidAt) : 0) - (a.paidAt ? +new Date(a.paidAt) : 0))
      : rs;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleSelectGroup(groupRows: PayoutWorklistRow[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const ids = groupRows.map((r) => r.id);
      const allIn = ids.length > 0 && ids.every((id) => next.has(id));
      if (allIn) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }
  function toggleCollapsed(t: PayoutDoctorType) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  }

  // ── period preset helpers ──
  function applyMonth(d: Date) {
    setCustom(null);
    setMonthDate(d);
    setPeriodOpen(false);
  }
  function applyCustom(p: { start: string; end: string; label: string }) {
    setCustom(p);
    setPeriodOpen(false);
  }

  // ── Mark paid (single / section / bulk / all) ──
  const [markPaidRows, setMarkPaidRows] = useState<PayoutWorklistRow[] | null>(null); // bulk set
  const [markPaidSingle, setMarkPaidSingle] = useState<PayoutWorklistRow | null>(null);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidBusy, setMarkPaidBusy] = useState(false);

  const openSingleMarkPaid = (r: PayoutWorklistRow) => {
    setMarkPaidSingle(r);
    setMarkPaidRows(null);
    setMarkPaidOpen(true);
  };
  const openBulkMarkPaid = (rowsToPay: PayoutWorklistRow[]) => {
    const pending = rowsToPay.filter((r) => r.status === "PENDING");
    if (pending.length === 0) {
      toast.error("No pending payouts in that selection.");
      return;
    }
    setMarkPaidRows(pending);
    setMarkPaidSingle(null);
    setMarkPaidOpen(true);
  };

  const bulkSplit = useMemo(() => {
    const list = markPaidRows ?? [];
    let commissions = 0;
    let lab = 0;
    const byType = new Map<PayoutDoctorType, { amount: number; count: number }>();
    for (const r of list) {
      if (r.payeeType === "LAB") lab += r.amountInPaise;
      else commissions += r.amountInPaise;
      const e = byType.get(r.payeeType) ?? { amount: 0, count: 0 };
      e.amount += r.amountInPaise;
      e.count += 1;
      byType.set(r.payeeType, e);
    }
    const breakdown = TYPE_ORDER.filter((t) => byType.has(t)).map((t) => ({
      label: TYPE_LABEL[t],
      amountInPaise: byType.get(t)!.amount,
      count: byType.get(t)!.count,
      outbound: t === "LAB",
    }));
    return { commissions, lab, total: commissions + lab, breakdown };
  }, [markPaidRows]);

  const submitMarkPaid = async (payment: PayoutMarkPaidPayment) => {
    setMarkPaidBusy(true);
    try {
      if (markPaidRows) {
        const ids = markPaidRows.map((r) => r.id);
        const res = await fetch(`${API_BASE}/payouts/mark-paid/bulk`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ ids, ...payment }),
        });
        const body = await res.json();
        if (!res.ok) {
          toast.error(body.message ?? "Failed to mark paid");
        } else {
          const r = body.data as { paidIds: string[]; conflictIds: string[]; notFoundIds: string[] };
          const parts = [`Marked ${r.paidIds.length} paid`];
          if (r.conflictIds.length) parts.push(`${r.conflictIds.length} already paid`);
          if (r.notFoundIds?.length) parts.push(`${r.notFoundIds.length} no longer exist`);
          setMarkPaidOpen(false);
          setSelected(new Set());
          await fetchWorklist();
          toast.success(parts.join(" · "), {
            action: { label: "See paid", onClick: () => setStatus("paid") },
          });
        }
      } else if (markPaidSingle) {
        const res = await fetch(`${API_BASE}/payouts/${markPaidSingle.id}/mark-paid`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payment),
        });
        const body = await res.json();
        if (!res.ok) toast.error(body.message ?? "Failed to mark paid");
        else {
          const paidId = markPaidSingle.id;
          setMarkPaidOpen(false);
          await fetchWorklist();
          toast.success("Marked as paid", {
            action: { label: "View receipt", onClick: () => navigate(`/owner/payouts/${paidId}`) },
          });
        }
      }
    } finally {
      setMarkPaidBusy(false);
    }
  };

  // ── Delete (owner, soft) ──
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const submitDelete = async () => {
    if (!isOwner || selectedRows.length === 0) return;
    setDeleteBusy(true);
    try {
      const ids = selectedRows.map((r) => r.id);
      const res = await fetch(`${API_BASE}/payouts/bulk`, {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ ids }),
      });
      const body = await res.json();
      if (!res.ok) toast.error(body.message ?? "Failed to delete");
      else {
        toast.success(`Deleted ${body.data?.deletedCount ?? ids.length}`);
        setDeleteOpen(false);
        setSelected(new Set());
        await fetchWorklist();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Export ──
  const exportExcel = async () => {
    if (!token || !activeBranchId) return;
    const params = new URLSearchParams();
    params.set("startDate", range.start);
    params.set("endDate", range.end + "T23:59:59.999Z");
    if (status !== "all") params.set("isPaid", status === "paid" ? "true" : "false");
    if (typeFilter !== "all") params.set("doctorType", typeFilter);
    if (q) params.set("q", q);
    const res = await fetch(`${API_BASE}/payouts/export?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Branch-Id": activeBranchId },
    });
    if (!res.ok) {
      toast.error("Failed to export");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payouts-${range.start}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const totals = worklist?.totals;
  const allPending = rows.filter((r) => r.status === "PENDING");
  const allPendingTotal = allPending.reduce((s, r) => s + r.amountInPaise, 0);
  const heroMax = Math.max(
    totals?.commissionsPendingInPaise ?? 0,
    totals?.labPayablesPendingInPaise ?? 0,
    1
  );
  const paidTotal = (totals?.commissionsPaidInPaise ?? 0) + (totals?.labPayablesPaidInPaise ?? 0);
  const paidCount = TYPE_ORDER.reduce((n, t) => n + (totals?.byType[t].paidCount ?? 0), 0);
  const filtered = typeFilter !== "all" || !!q; // the row list is narrowed → "all" would be a lie

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1440 }} className="pb-24 print:hidden">
        <OwnerPageHeader
          title="Payouts · Pay-Run"
          subtitle={`Settle everyone for the period · ${periodLabel}`}
          rightSlot={
            <>
              {custom ? (
                <button
                  className="inline-flex items-center gap-2 rounded-md border bg-white px-2.5 py-1.5"
                  style={{ fontSize: 12, borderColor: TOKENS.border }}
                  onClick={() => setCustom(null)}
                  title="Back to monthly"
                >
                  <CalendarRange className="h-4 w-4" /> {custom.label} ✕
                </button>
              ) : (
                <div
                  className="inline-flex items-center gap-2 rounded-md border bg-white px-2.5 py-1.5"
                  style={{ fontSize: 12, borderColor: TOKENS.border }}
                >
                  <button onClick={() => setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="font-medium" style={{ minWidth: 92, textAlign: "center" }}>
                    {monthLabel}
                  </span>
                  <button onClick={() => setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              )}
              <button
                className="rounded-md border bg-white px-2.5 py-1.5"
                style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.textSecondary }}
                onClick={() => setPeriodOpen((o) => !o)}
              >
                Custom range ▾
              </button>
              <RefreshButton isFetching={loading} onClick={fetchWorklist} />
              <Button variant="outline" size="sm" onClick={exportExcel}>
                <Download className="mr-1.5 h-4 w-4" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="mr-1.5 h-4 w-4" /> Register
              </Button>
            </>
          }
        />

        {/* Custom range panel */}
        {periodOpen && (
          <SectionCard className="mb-4">
            <div className="flex flex-wrap items-center gap-2" style={{ fontSize: 12 }}>
              <span className="font-medium" style={{ color: TOKENS.textSecondary }}>Quick pick</span>
              {[
                { label: "This month", on: () => applyMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) },
                { label: "Last month", on: () => applyMonth(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)) },
                { label: "Last 30 days", on: () => applyCustom({ ...last30(), label: "Last 30 days" }) },
                { label: "This quarter", on: () => applyCustom({ ...quarterRange(), label: "This quarter" }) },
                { label: "This FY", on: () => applyCustom(fyRange()) },
              ].map((p) => (
                <button
                  key={p.label}
                  onClick={p.on}
                  className="rounded-md border bg-white px-2.5 py-1"
                  style={{ borderColor: TOKENS.border, color: TOKENS.textSecondary }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2" style={{ fontSize: 12 }}>
              <span className="font-medium" style={{ color: TOKENS.textSecondary }}>Custom</span>
              From
              <Input type="date" className="h-8 w-40" value={fromInput} onChange={(e) => setFromInput(e.target.value)} />
              To
              <Input type="date" className="h-8 w-40" value={toInput} onChange={(e) => setToInput(e.target.value)} />
              <Button
                size="sm"
                disabled={!fromInput || !toInput}
                onClick={() =>
                  applyCustom({ start: fromInput, end: toInput, label: `${fromInput} → ${toInput}` })
                }
              >
                Apply
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPeriodOpen(false)}>
                Cancel
              </Button>
            </div>
          </SectionCard>
        )}

        {loading && !worklist ? (
          <FullPageSkeleton rows={3} />
        ) : (
          <div className="space-y-4">
            {/* Two non-netting hero numbers */}
            <SectionCard>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <div
                    className="mb-1.5 font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.textSecondary }}
                  >
                    Commission payouts · pending
                  </div>
                  <DisplayNumber size={30}>
                    {formatRupees(totals?.commissionsPendingInPaise ?? 0)}
                  </DisplayNumber>
                  <div style={{ fontSize: 11, color: TOKENS.textTertiary, marginTop: 2 }}>
                    What you owe referrers &amp; clinics
                  </div>
                  <div className="mt-2">
                    <MiniBar fillRatio={(totals?.commissionsPendingInPaise ?? 0) / heroMax} color="#9aa7b8" />
                  </div>
                  <div className="mt-1" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                    {(totals?.byType.REFERRAL.pendingCount ?? 0) +
                      (totals?.byType.CLINIC.pendingCount ?? 0) +
                      (totals?.byType.DIAGNOSTIC_CENTER.pendingCount ?? 0)}{" "}
                    pending
                  </div>
                </div>
                <div className="md:border-l md:pl-4" style={{ borderColor: TOKENS.border }}>
                  <div
                    className="mb-1.5 font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.caution }}
                  >
                    Outside-lab payables · pending
                  </div>
                  <DisplayNumber size={30}>
                    <span style={{ color: TOKENS.caution }}>
                      {formatRupees(totals?.labPayablesPendingInPaise ?? 0)}
                    </span>
                  </DisplayNumber>
                  <div style={{ fontSize: 11, color: TOKENS.textTertiary, marginTop: 2 }}>
                    What you owe outside labs for outsourced tests
                  </div>
                  <div className="mt-2">
                    <MiniBar fillRatio={(totals?.labPayablesPendingInPaise ?? 0) / heroMax} color={TOKENS.caution} />
                  </div>
                  <div className="mt-1" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                    {totals?.byType.LAB.pendingCount ?? 0} pending
                  </div>
                </div>
              </div>
              <div
                className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3"
                style={{ borderColor: TOKENS.border, fontSize: 12, color: TOKENS.textSecondary }}
              >
                {TYPE_ORDER.map((t) => (
                  <span key={t}>
                    {TYPE_LABEL[t]}{" "}
                    <span
                      className="font-medium"
                      style={{ color: t === "LAB" ? TOKENS.caution : TOKENS.textPrimary }}
                    >
                      {formatRupees(totals?.byType[t].pendingAmountInPaise ?? 0)}
                    </span>{" "}
                    ({totals?.byType[t].pendingCount ?? 0})
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setStatus(status === "paid" ? "pending" : "paid")}
                  style={{
                    marginLeft: "auto",
                    color: status === "paid" ? TOKENS.info : TOKENS.textTertiary,
                    textDecoration: "underline",
                    textUnderlineOffset: 2,
                  }}
                  title={status === "paid" ? "Back to pending" : "Show what's already been paid"}
                >
                  {status === "paid"
                    ? "← Back to pending"
                    : `Already paid: ${formatRupees(
                        (totals?.commissionsPaidInPaise ?? 0) + (totals?.labPayablesPaidInPaise ?? 0)
                      )}`}
                </button>
              </div>
              {allPending.length > 0 && status !== "paid" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => openBulkMarkPaid(allPending)}>
                    {filtered
                      ? `Review & Pay ${allPending.length} shown → ${formatRupees(allPendingTotal)}`
                      : `Review & Pay all pending (${allPending.length}) → ${formatRupees(allPendingTotal)}`}
                  </Button>
                  {filtered && (
                    <span style={{ fontSize: 11, color: TOKENS.caution }}>
                      Filter active — only the rows below
                    </span>
                  )}
                </div>
              )}
            </SectionCard>

            {/* Filters */}
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex overflow-hidden rounded-md border"
                style={{ borderColor: TOKENS.border, fontSize: 12 }}
              >
                {TYPE_FILTERS.map((f, i) => (
                  <button
                    key={f.key}
                    onClick={() => setTypeFilter(f.key)}
                    className="px-3 py-1.5"
                    style={{
                      background: f.key === typeFilter ? TOKENS.textPrimary : "white",
                      color: f.key === typeFilter ? "white" : TOKENS.textSecondary,
                      borderLeft: i === 0 ? "none" : `0.5px solid ${TOKENS.border}`,
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger className="h-9 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="paid">{paidCount > 0 ? `Paid (${paidCount})` : "Paid"}</SelectItem>
                </SelectContent>
              </Select>
              <div
                className="inline-flex overflow-hidden rounded-md border"
                style={{ borderColor: TOKENS.border, fontSize: 12 }}
              >
                {(["grouped", "flat"] as const).map((v, i) => (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className="px-3 py-1.5 capitalize"
                    style={{
                      background: v === view ? TOKENS.textPrimary : "white",
                      color: v === view ? "white" : TOKENS.textSecondary,
                      borderLeft: i === 0 ? "none" : `0.5px solid ${TOKENS.border}`,
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="relative min-w-[180px] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search payee…"
                  className="h-9 pl-9"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
            </div>

            {/* Body */}
            {rows.length === 0 ? (
              <SectionCard>
                {status === "pending" && paidTotal > 0 ? (
                  <div className="flex flex-col items-center gap-2 py-6 text-center">
                    <CheckCircle2 className="h-8 w-8" style={{ color: TOKENS.healthy }} />
                    <div style={{ fontSize: 15, fontWeight: 600 }}>All settled for {periodLabel}</div>
                    <div style={{ fontSize: 13, color: TOKENS.textTertiary }}>
                      Everyone has been paid — {formatRupees(paidTotal)} across {paidCount}{" "}
                      {paidCount === 1 ? "payout" : "payouts"}.
                    </div>
                    <Button variant="outline" size="sm" className="mt-1" onClick={() => setStatus("paid")}>
                      View paid
                    </Button>
                  </div>
                ) : (
                  <EmptyState
                    label={status === "paid" ? "Nothing paid yet for this period" : "No payouts for this period"}
                    hint={
                      status === "paid"
                        ? "Mark payouts paid and they'll appear here."
                        : "Try a different month or custom range."
                    }
                  />
                )}
              </SectionCard>
            ) : view === "flat" ? (
              <SectionCard padding={0}>
                <RowsTable
                  rows={sortForDisplay(rows)}
                  selected={selected}
                  onToggle={toggleRow}
                  onStatement={(id) => navigate(`/owner/payouts/${id}`)}
                  onReprint={(id) => navigate(`/owner/payouts/${id}?print=1`)}
                  onMarkPaid={openSingleMarkPaid}
                  showType
                />
              </SectionCard>
            ) : (
              groups.map((g) => {
                const outbound = g.payeeType === "LAB";
                const isCollapsed = collapsed.has(g.payeeType);
                const sectionPending = g.rows.filter((r) => r.status === "PENDING");
                return (
                  <div key={g.payeeType}>
                    {outbound && (
                      <div
                        className="mb-1.5 mt-2 flex items-center gap-2 font-medium uppercase"
                        style={{ fontSize: 11, letterSpacing: "0.05em", color: TOKENS.caution }}
                      >
                        <span style={{ flex: 1, height: 1, background: "#e0cfa3" }} />
                        Outside-lab payables
                        <span style={{ flex: 1, height: 1, background: "#e0cfa3" }} />
                      </div>
                    )}
                    <SectionCard padding={0}>
                      <div
                        className="flex items-center gap-3 px-3 py-2"
                        style={{
                          background: outbound ? "#fbf7ee" : "#f6f5f2",
                          borderTopLeftRadius: 12,
                          borderTopRightRadius: 12,
                          cursor: "pointer",
                        }}
                        onClick={() => toggleCollapsed(g.payeeType)}
                      >
                        <input
                          type="checkbox"
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleSelectGroup(g.rows)}
                          checked={g.rows.length > 0 && g.rows.every((r) => selected.has(r.id))}
                          title="Select all in this section"
                        />
                        <ChevronDown
                          className="h-4 w-4 transition-transform"
                          style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", color: TOKENS.textTertiary }}
                        />
                        <span className="font-medium" style={{ fontSize: 12 }}>
                          {TYPE_LABEL[g.payeeType]}
                        </span>
                        <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                          {sectionPending.length} pending ·{" "}
                          <span
                            className="font-medium"
                            style={{ color: outbound ? TOKENS.caution : TOKENS.textPrimary }}
                          >
                            {formatRupees(g.pendingInPaise)}
                          </span>
                        </span>
                        {outbound && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate("/owner/payouts/labs");
                            }}
                            style={{
                              fontSize: 12,
                              color: TOKENS.info,
                              marginLeft: sectionPending.length > 0 ? undefined : "auto",
                            }}
                          >
                            Manage rates →
                          </button>
                        )}
                        {sectionPending.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-auto h-7"
                            onClick={(e) => {
                              e.stopPropagation();
                              openBulkMarkPaid(sectionPending);
                            }}
                          >
                            Review &amp; pay ({sectionPending.length}) · {formatRupees(g.pendingInPaise)}
                          </Button>
                        )}
                      </div>
                      {!isCollapsed && (
                        <RowsTable
                          rows={sortForDisplay(g.rows)}
                          selected={selected}
                          onToggle={toggleRow}
                          onStatement={(id) => navigate(`/owner/payouts/${id}`)}
                          onReprint={(id) => navigate(`/owner/payouts/${id}?print=1`)}
                          onMarkPaid={openSingleMarkPaid}
                        />
                      )}
                    </SectionCard>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <RegisterPrint worklist={worklist} periodLabel={periodLabel} />

      <PayoutBulkActionBar
        count={selected.size}
        totalInPaise={selectedTotalInPaise}
        isOwner={isOwner}
        onMarkPaid={() => openBulkMarkPaid(selectedRows)}
        onDelete={() => isOwner && selected.size > 0 && setDeleteOpen(true)}
        onExport={exportExcel}
        onClear={() => setSelected(new Set())}
      />

      <PayoutMarkPaidDialog
        open={markPaidOpen}
        onOpenChange={setMarkPaidOpen}
        busy={markPaidBusy}
        title={markPaidRows ? "Review & mark paid" : undefined}
        payout={
          markPaidSingle
            ? {
                id: markPaidSingle.id,
                doctorType: markPaidSingle.payeeType,
                doctorId: markPaidSingle.payeeId,
                doctorName: markPaidSingle.payeeName,
                branchId: activeBranchId ?? "",
                branchName: "",
                periodStartDate: markPaidSingle.periodStartDate,
                periodEndDate: markPaidSingle.periodEndDate,
                derivedAmountInPaise: markPaidSingle.amountInPaise,
                derivedAt: "",
                paidAt: markPaidSingle.paidAt,
                paymentMethod: markPaidSingle.paymentMethod,
              }
            : null
        }
        bulkCount={markPaidRows ? markPaidRows.length : 0}
        bulkTotalInPaise={bulkSplit.total}
        commissionsInPaise={markPaidRows ? bulkSplit.commissions : undefined}
        labPayablesInPaise={markPaidRows ? bulkSplit.lab : undefined}
        breakdown={markPaidRows ? bulkSplit.breakdown : undefined}
        onViewStatement={
          markPaidSingle ? () => navigate(`/owner/payouts/${markPaidSingle.id}`) : undefined
        }
        onConfirm={submitMarkPaid}
      />

      <PayoutDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        count={selectedRows.length}
        busy={deleteBusy}
        onConfirm={submitDelete}
      />
    </AppLayout>
  );
}

// ── Rows table (shared by grouped + flat) ────────────────────────────────────
function RowsTable({
  rows,
  selected,
  onToggle,
  onStatement,
  onMarkPaid,
  onReprint,
  showType,
}: {
  rows: PayoutWorklistRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onStatement: (id: string) => void;
  onMarkPaid: (r: PayoutWorklistRow) => void;
  onReprint: (id: string) => void;
  showType?: boolean;
}) {
  return (
    <table className="w-full" style={{ fontSize: 12 }}>
      <thead>
        <tr style={{ color: TOKENS.textTertiary, fontSize: 11, textAlign: "left" }}>
          <th className="py-1 pl-3 font-normal" style={{ width: 28 }} />
          <th className="py-1 font-normal">Payee</th>
          <th className="py-1 text-right font-normal">Amount</th>
          <th className="py-1 text-right font-normal">Status</th>
          <th className="py-1 pr-3 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const outbound = r.payeeType === "LAB";
          const paid = r.status === "PAID";
          return (
            <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
              <td className="py-2 pl-3" style={{ width: 28 }}>
                <input type="checkbox" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} />
              </td>
              <td className="py-2">
                {/* The payee name is the primary drill-in — opens the statement/receipt. */}
                <button
                  className="text-left hover:underline"
                  style={{ color: TOKENS.textPrimary, fontWeight: 500 }}
                  onClick={() => onStatement(r.id)}
                  title="Open statement"
                >
                  {r.payeeName}
                </button>{" "}
                <span
                  style={{
                    fontSize: 10,
                    border: `1px solid ${TOKENS.border}`,
                    borderRadius: 4,
                    padding: "1px 5px",
                    color: TOKENS.textSecondary,
                    marginLeft: 4,
                  }}
                >
                  {TYPE_BADGE[r.payeeType]}
                </span>
              </td>
              <td
                className="py-2 text-right font-medium tabular-nums"
                style={{ color: outbound ? TOKENS.caution : TOKENS.textPrimary }}
              >
                {formatRupees(r.amountInPaise)}
              </td>
              <td className="py-2 text-right" style={{ width: 110 }}>
                <span
                  className="font-medium"
                  style={{ fontSize: 11, color: paid ? TOKENS.healthy : TOKENS.caution }}
                >
                  {paid ? "PAID" : outbound ? "UNPAID" : "PENDING"}
                </span>
                {paid && r.paidAt && (
                  <div style={{ fontSize: 10, color: TOKENS.textTertiary }}>
                    {new Date(r.paidAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                    })}
                  </div>
                )}
              </td>
              <td className="py-2 pr-3 text-right" style={{ width: 180 }}>
                <button className="mr-2" style={{ color: TOKENS.info, fontSize: 12 }} onClick={() => onStatement(r.id)}>
                  {paid ? "Receipt" : "Statement"}
                </button>
                {paid ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => onReprint(r.id)}
                    title="Reprint receipt"
                  >
                    <Printer className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="h-7" onClick={() => onMarkPaid(r)}>
                    Mark Paid
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export { PayoutsList };

const LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

// All-payee register — print-only (global .print-content rule reveals it).
function RegisterPrint({
  worklist,
  periodLabel,
}: {
  worklist: PayRunWorklist | null;
  periodLabel: string;
}) {
  if (!worklist) return null;
  const td: CSSProperties = { border: "1px solid #999", padding: "3px 6px", fontSize: 10 };
  const th: CSSProperties = { ...td, background: "#eee", fontWeight: 600, textAlign: "left" };
  const rt: CSSProperties = { textAlign: "right" };
  const t = worklist.totals;
  return (
    <div className="hidden print:block print-content print-page">
      <div style={{ textAlign: "center", borderBottom: "2px solid #111", paddingBottom: 8, marginBottom: 12 }}>
        <img src={LOGO_URL} alt="Sobhana" style={{ height: 46 }} />
        <div style={{ fontWeight: 700, letterSpacing: "0.12em", marginTop: 6, fontSize: 13 }}>
          PAYOUTS REGISTER — {periodLabel.toUpperCase()}
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
        <thead>
          <tr>
            <th style={th}>Payee</th>
            <th style={th}>Type</th>
            <th style={{ ...th, ...rt }}>Amount</th>
            <th style={th}>Status</th>
            <th style={th}>Paid on</th>
          </tr>
        </thead>
        <tbody>
          {worklist.rows.map((r) => (
            <tr key={r.id}>
              <td style={td}>{r.payeeName}</td>
              <td style={td}>{TYPE_BADGE[r.payeeType]}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(r.amountInPaise)}</td>
              <td style={td}>{r.status === "PAID" ? "Paid" : r.payeeType === "LAB" ? "Unpaid" : "Pending"}</td>
              <td style={td}>{r.paidAt ? new Date(r.paidAt).toLocaleDateString("en-IN") : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 700 }}>
            <td style={td} colSpan={2}>Commission payouts</td>
            <td style={{ ...td, ...rt }}>{formatRupees(t.commissionsTotalInPaise)}</td>
            <td style={td} colSpan={2}></td>
          </tr>
          <tr style={{ fontWeight: 700 }}>
            <td style={td} colSpan={2}>Outside-lab payables</td>
            <td style={{ ...td, ...rt }}>{formatRupees(t.labPayablesTotalInPaise)}</td>
            <td style={td} colSpan={2}></td>
          </tr>
        </tfoot>
      </table>
      <div style={{ fontSize: 10, color: "#666" }}>
        Commissions and lab payables are shown separately and never netted. Soft-deleted payouts are excluded.
      </div>
    </div>
  );
}

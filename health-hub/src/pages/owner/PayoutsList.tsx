import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { API_BASE, API_BASE_URL } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CalendarRange,
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
  PayoutDoctorType,
} from "@/types";
import { PayoutBulkActionBar } from "@/components/payouts/PayoutBulkActionBar";
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

  // Filters seed from the URL so the view is shareable and survives a round-trip
  // into a statement and back. Period: a month stepper by default; "custom"
  // overrides with a preset / range.
  const [monthDate, setMonthDate] = useState(() => {
    const m = searchParams.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      const [y, mo] = m.split("-").map(Number);
      return new Date(y, mo - 1, 1);
    }
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1); // current month by default
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
  }, [typeFilter, view, custom, monthDate, q]);

  const range = useMemo(
    () => (custom ? { start: custom.start, end: custom.end } : monthRange(monthDate)),
    [custom, monthDate]
  );
  const monthLabel = monthDate.toLocaleString("en-IN", { month: "long", year: "numeric" });
  const periodLabel = custom ? custom.label : monthLabel;

  // Persist the picked period so a statement opened afterwards — even from a
  // bare/cached URL that lost ?from/?to — reflects THIS range instead of
  // silently defaulting to the current month.
  useEffect(() => {
    try {
      localStorage.setItem(
        "payout-period",
        JSON.stringify({ from: range.start, to: range.end, plabel: periodLabel })
      );
    } catch {
      /* localStorage unavailable — URL still carries the range */
    }
  }, [range.start, range.end, periodLabel]);

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": activeBranchId ?? "",
    "Content-Type": "application/json",
  });

  const [worklist, setWorklist] = useState<PayRunWorklist | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Selection is off by default; a "Select" toggle reveals the row checkboxes.
  const [selectMode, setSelectMode] = useState(false);
  // When set, the print-only register renders just these payout ids (bulk Print
  // of the selected rows); null ⇒ the full-period register (top "Register" btn).
  const [printIds, setPrintIds] = useState<string[] | null>(null);

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
  }, [token, activeBranchId, range.start, range.end, typeFilter, q, view]);

  const rows = worklist?.rows ?? [];
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const selectedTotalInPaise = selectedRows.reduce((s, r) => s + r.amountInPaise, 0);

  const groups = useMemo(() => {
    const g = worklist?.groups ?? [];
    return [...g].sort(
      (a, b) => TYPE_ORDER.indexOf(a.payeeType) - TYPE_ORDER.indexOf(b.payeeType)
    );
  }, [worklist]);

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

  // ── Delete (owner, soft) ──
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const submitDelete = async () => {
    if (!isOwner || selectedRows.length === 0) return;
    setDeleteBusy(true);
    try {
      // Rows are per-doctor aggregates, so delete every ledger row these payees
      // have inside the selected range (not a single ledger id).
      const payees = selectedRows.map((r) => ({ payeeType: r.payeeType, payeeId: r.payeeId }));
      const res = await fetch(`${API_BASE}/payouts/by-doctor`, {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({
          payees,
          startDate: range.start,
          endDate: range.end + "T23:59:59.999Z",
        }),
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

  // ── Select mode ──
  function toggleSelectMode() {
    setSelectMode((on) => {
      if (on) setSelected(new Set()); // leaving select mode clears the ticks
      return !on;
    });
  }

  // ── Print selected (bulk) ──
  // Stage the selected ids, let the print-only register re-render filtered, then
  // fire the browser print dialog and reset.
  const printSelected = () => {
    if (selectedRows.length === 0) return;
    setPrintIds(selectedRows.map((r) => r.id));
  };
  useEffect(() => {
    if (!printIds) return;
    const t = setTimeout(() => {
      window.print();
      setPrintIds(null);
    }, 60);
    return () => clearTimeout(t);
  }, [printIds]);

  // Worklist rows are now per-doctor aggregates keyed by `TYPE.payeeId`. The
  // statement page reads that identity plus the range below to derive the whole
  // period, so both are threaded through the URL.
  // Carry the exact period label ("August 2026" / custom label) into the
  // statement so its header (screen, print, Excel) reads identically to the
  // range chosen up top.
  const rangeQuery = `from=${range.start}&to=${range.end}&plabel=${encodeURIComponent(periodLabel)}`;
  const openStatement = (id: string) => navigate(`/owner/payouts/${id}?${rangeQuery}`);
  const openPrintStatement = (id: string) =>
    navigate(`/owner/payouts/${id}?print=1&${rangeQuery}`);

  // ── Export ──
  // Pass `payeeIds` to scope the export to the selected doctors; omit for the
  // whole period (top-of-page Excel button).
  const exportExcel = async (payeeIds?: string[]) => {
    if (!token || !activeBranchId) return;
    const params = new URLSearchParams();
    params.set("startDate", range.start);
    params.set("endDate", range.end + "T23:59:59.999Z");
    if (typeFilter !== "all") params.set("doctorType", typeFilter);
    if (q) params.set("q", q);
    if (payeeIds && payeeIds.length) params.set("payeeIds", payeeIds.join(","));
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
  const heroMax = Math.max(
    totals?.commissionsTotalInPaise ?? 0,
    totals?.labPayablesTotalInPaise ?? 0,
    1
  );

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1440 }} className="pb-24 print:hidden">
        <OwnerPageHeader
          title="Payouts · Pay-Run"
          subtitle={`Commission for the period · ${periodLabel}`}
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
              <Button variant="outline" size="sm" onClick={() => exportExcel()}>
                <Download className="mr-1.5 h-4 w-4" /> Excel
              </Button>
              <Button variant="outline" size="sm" onClick={() => { setPrintIds(null); window.print(); }}>
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
            {/* Two non-netting hero totals */}
            <SectionCard>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <div
                    className="mb-1.5 font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.textSecondary }}
                  >
                    Commission payouts
                  </div>
                  <DisplayNumber size={30}>
                    {formatRupees(totals?.commissionsTotalInPaise ?? 0)}
                  </DisplayNumber>
                  <div className="mt-2">
                    <MiniBar fillRatio={(totals?.commissionsTotalInPaise ?? 0) / heroMax} color="#9aa7b8" />
                  </div>
                  <div className="mt-1" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                    What you owe referrers &amp; clinics
                  </div>
                </div>
                <div className="md:border-l md:pl-4" style={{ borderColor: TOKENS.border }}>
                  <div
                    className="mb-1.5 font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.caution }}
                  >
                    Outside-lab payables
                  </div>
                  <DisplayNumber size={30}>
                    <span style={{ color: TOKENS.caution }}>
                      {formatRupees(totals?.labPayablesTotalInPaise ?? 0)}
                    </span>
                  </DisplayNumber>
                  <div className="mt-2">
                    <MiniBar fillRatio={(totals?.labPayablesTotalInPaise ?? 0) / heroMax} color={TOKENS.caution} />
                  </div>
                  <div className="mt-1" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                    What you owe outside labs for outsourced tests
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
                      {formatRupees(totals?.byType[t].amountInPaise ?? 0)}
                    </span>{" "}
                    ({totals?.byType[t].count ?? 0})
                  </span>
                ))}
                <span style={{ marginLeft: "auto", color: TOKENS.textTertiary }}>
                  {totals?.payeeCount ?? 0} payees
                </span>
              </div>
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
              <button
                onClick={toggleSelectMode}
                className="rounded-md border px-3 py-1.5"
                style={{
                  fontSize: 12,
                  borderColor: TOKENS.border,
                  background: selectMode ? TOKENS.textPrimary : "white",
                  color: selectMode ? "white" : TOKENS.textSecondary,
                }}
                title="Show checkboxes to select payouts"
              >
                {selectMode ? "Done" : "Select"}
              </button>
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
                <EmptyState
                  label="No payouts for this period"
                  hint="Try a different month or custom range."
                />
              </SectionCard>
            ) : view === "flat" ? (
              <SectionCard padding={0}>
                <RowsTable
                  rows={rows}
                  selected={selected}
                  selectMode={selectMode}
                  onToggle={toggleRow}
                  onStatement={openStatement}
                  onPrint={openPrintStatement}
                  showType
                />
              </SectionCard>
            ) : (
              groups.map((g) => {
                const outbound = g.payeeType === "LAB";
                const isCollapsed = collapsed.has(g.payeeType);
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
                        {selectMode && (
                          <input
                            type="checkbox"
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSelectGroup(g.rows)}
                            checked={g.rows.length > 0 && g.rows.every((r) => selected.has(r.id))}
                            title="Select all in this section"
                          />
                        )}
                        <ChevronDown
                          className="h-4 w-4 transition-transform"
                          style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", color: TOKENS.textTertiary }}
                        />
                        <span className="font-medium" style={{ fontSize: 12 }}>
                          {TYPE_LABEL[g.payeeType]}
                        </span>
                        <span style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                          {g.rows.length} {g.rows.length === 1 ? "payee" : "payees"} ·{" "}
                          <span
                            className="font-medium"
                            style={{ color: outbound ? TOKENS.caution : TOKENS.textPrimary }}
                          >
                            {formatRupees(g.subtotalInPaise)}
                          </span>
                        </span>
                        {outbound && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate("/owner/payouts/labs");
                            }}
                            style={{ fontSize: 12, color: TOKENS.info, marginLeft: "auto" }}
                          >
                            Manage rates →
                          </button>
                        )}
                      </div>
                      {!isCollapsed && (
                        <RowsTable
                          rows={g.rows}
                          selected={selected}
                          selectMode={selectMode}
                          onToggle={toggleRow}
                          onStatement={(id) => navigate(`/owner/payouts/${id}`)}
                          onPrint={(id) => navigate(`/owner/payouts/${id}?print=1`)}
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

      <RegisterPrint worklist={worklist} periodLabel={periodLabel} onlyIds={printIds} />

      <PayoutBulkActionBar
        count={selected.size}
        totalInPaise={selectedTotalInPaise}
        selectionNoun="payouts"
        isOwner={isOwner}
        onDelete={() => isOwner && selected.size > 0 && setDeleteOpen(true)}
        onPrint={printSelected}
        onExport={() => exportExcel(selectedRows.map((r) => r.payeeId))}
        onClear={() => setSelected(new Set())}
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
  selectMode,
  onToggle,
  onStatement,
  onPrint,
  showType,
}: {
  rows: PayoutWorklistRow[];
  selected: Set<string>;
  selectMode?: boolean;
  onToggle: (id: string) => void;
  onStatement: (id: string) => void;
  onPrint: (id: string) => void;
  showType?: boolean;
}) {
  return (
    <table className="w-full" style={{ fontSize: 12 }}>
      <thead>
        <tr style={{ color: TOKENS.textTertiary, fontSize: 11, textAlign: "left" }}>
          {selectMode && <th className="py-1 pl-3 font-normal" style={{ width: 28 }} />}
          <th className="py-1 font-normal">Payee</th>
          <th className="py-1 text-right font-normal">Amount</th>
          <th className="py-1 pr-3 text-right font-normal">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const outbound = r.payeeType === "LAB";
          return (
            <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
              {selectMode && (
                <td className="py-2 pl-3" style={{ width: 28 }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} />
                </td>
              )}
              <td className="py-2">
                {/* The payee name is the primary drill-in — opens the statement. */}
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
              <td className="py-2 pr-3 text-right" style={{ width: 160 }}>
                <button className="mr-2" style={{ color: TOKENS.info, fontSize: 12 }} onClick={() => onStatement(r.id)}>
                  Statement
                </button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  onClick={() => onPrint(r.id)}
                  title="Print statement"
                >
                  <Printer className="h-3.5 w-3.5" />
                </Button>
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
  onlyIds,
}: {
  worklist: PayRunWorklist | null;
  periodLabel: string;
  onlyIds?: string[] | null;
}) {
  if (!worklist) return null;
  const td: CSSProperties = { border: "1px solid #999", padding: "3px 6px", fontSize: 10 };
  const th: CSSProperties = { ...td, background: "#eee", fontWeight: 600, textAlign: "left" };
  const rt: CSSProperties = { textAlign: "right" };
  // When a selection is being printed, restrict rows to it and recompute the
  // two footers from the filtered set so the printed totals stay consistent.
  const idSet = onlyIds && onlyIds.length ? new Set(onlyIds) : null;
  const printRows = idSet ? worklist.rows.filter((r) => idSet.has(r.id)) : worklist.rows;
  const t = idSet
    ? printRows.reduce(
        (acc, r) => {
          if (r.payeeType === "LAB") acc.labPayablesTotalInPaise += r.amountInPaise;
          else acc.commissionsTotalInPaise += r.amountInPaise;
          return acc;
        },
        { commissionsTotalInPaise: 0, labPayablesTotalInPaise: 0 }
      )
    : worklist.totals;
  return (
    <div className="hidden print:block print-content print-page">
      <div style={{ textAlign: "center", borderBottom: "2px solid #111", paddingBottom: 8, marginBottom: 12 }}>
        <img src={LOGO_URL} alt="Sobhana" style={{ height: 46 }} />
        <div style={{ fontWeight: 700, letterSpacing: "0.12em", marginTop: 6, fontSize: 13 }}>
          PAYOUTS REGISTER — {periodLabel.toUpperCase()}
          {idSet ? ` · ${printRows.length} SELECTED` : ""}
        </div>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
        <thead>
          <tr>
            <th style={th}>Payee</th>
            <th style={th}>Type</th>
            <th style={{ ...th, ...rt }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {printRows.map((r) => (
            <tr key={r.id}>
              <td style={td}>{r.payeeName}</td>
              <td style={td}>{TYPE_BADGE[r.payeeType]}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(r.amountInPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 700 }}>
            <td style={td} colSpan={2}>Commission payouts</td>
            <td style={{ ...td, ...rt }}>{formatRupees(t.commissionsTotalInPaise)}</td>
          </tr>
          <tr style={{ fontWeight: 700 }}>
            <td style={td} colSpan={2}>Outside-lab payables</td>
            <td style={{ ...td, ...rt }}>{formatRupees(t.labPayablesTotalInPaise)}</td>
          </tr>
        </tfoot>
      </table>
      <div style={{ fontSize: 10, color: "#666" }}>
        Commissions and lab payables are shown separately and never netted. Soft-deleted payouts are excluded.
      </div>
    </div>
  );
}

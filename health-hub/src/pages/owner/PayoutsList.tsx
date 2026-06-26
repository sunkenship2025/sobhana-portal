import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "@/lib/api";
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
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { formatRupees } from "@/lib/payoutFormatters";
import {
  OwnerPageHeader,
  SectionCard,
  DisplayNumber,
  TOKENS,
  EmptyState,
  FullPageSkeleton,
  RefreshButton,
} from "./_shared/ownerUi";
import {
  PayRunWorklist,
  PayoutWorklistRow,
  PayoutSummary,
  PaymentType,
  PayoutDoctorType,
} from "@/types";
import { PayoutBulkActionBar } from "@/components/payouts/PayoutBulkActionBar";
import { PayoutMarkPaidDialog } from "@/components/payouts/PayoutMarkPaidDialog";
import { PayoutDeleteDialog } from "@/components/payouts/PayoutDeleteDialog";

type TypeFilter = "all" | PayoutDoctorType;

// Display order + labels for the four payee types.
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

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
function monthRange(d: Date) {
  return {
    startDate: ymd(new Date(d.getFullYear(), d.getMonth(), 1)),
    endDate: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)),
  };
}

export default function PayoutsList() {
  const { token, user } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();
  const isOwner = user?.role === "owner";

  // Default to the last completed calendar month (the pay-run default).
  const [monthDate, setMonthDate] = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth() - 1, 1);
  });
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<"all" | "pending" | "paid">("pending");
  const [view] = useState<"grouped" | "flat">("grouped");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const range = useMemo(() => monthRange(monthDate), [monthDate]);
  const monthLabel = monthDate.toLocaleString("en-IN", { month: "long", year: "numeric" });

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
      params.set("startDate", range.startDate);
      params.set("endDate", range.endDate + "T23:59:59.999Z");
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
  }, [token, activeBranchId, range.startDate, range.endDate, status, typeFilter, q, view]);

  const rows = worklist?.rows ?? [];
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected]
  );
  const selectedPending = selectedRows.filter((r) => r.status === "PENDING");
  const selectedTotalInPaise = selectedRows.reduce((s, r) => s + r.amountInPaise, 0);

  const groups = useMemo(() => {
    const g = worklist?.groups ?? [];
    return [...g].sort(
      (a, b) => TYPE_ORDER.indexOf(a.payeeType) - TYPE_ORDER.indexOf(b.payeeType)
    );
  }, [worklist]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // ---------------- Mark paid (single + bulk) ----------------
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidTarget, setMarkPaidTarget] = useState<PayoutSummary | null>(null);
  const [markPaidIsBulk, setMarkPaidIsBulk] = useState(false);
  const [markPaidBusy, setMarkPaidBusy] = useState(false);

  function rowToSummary(r: PayoutWorklistRow): PayoutSummary {
    return {
      id: r.id,
      doctorType: r.payeeType,
      doctorId: r.payeeId,
      doctorName: r.payeeName,
      branchId: activeBranchId ?? "",
      branchName: "",
      periodStartDate: r.periodStartDate,
      periodEndDate: r.periodEndDate,
      derivedAmountInPaise: r.amountInPaise,
      derivedAt: "",
      paidAt: r.paidAt,
      paymentMethod: r.paymentMethod,
    };
  }

  const openSingleMarkPaid = (r: PayoutWorklistRow) => {
    setMarkPaidTarget(rowToSummary(r));
    setMarkPaidIsBulk(false);
    setMarkPaidOpen(true);
  };
  const openBulkMarkPaid = () => {
    if (selectedPending.length === 0) {
      toast.error("Select at least one pending payout.");
      return;
    }
    setMarkPaidIsBulk(true);
    setMarkPaidTarget(null);
    setMarkPaidOpen(true);
  };

  const submitMarkPaid = async (payment: {
    paymentMethod: PaymentType;
    paymentReferenceId?: string;
    notes?: string;
  }) => {
    setMarkPaidBusy(true);
    try {
      if (markPaidIsBulk) {
        const ids = selectedPending.map((r) => r.id);
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
          toast.success(parts.join(" · "));
          setMarkPaidOpen(false);
          setSelected(new Set());
          await fetchWorklist();
        }
      } else if (markPaidTarget) {
        const res = await fetch(`${API_BASE}/payouts/${markPaidTarget.id}/mark-paid`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(payment),
        });
        const body = await res.json();
        if (!res.ok) {
          toast.error(body.message ?? "Failed to mark paid");
        } else {
          toast.success("Marked as paid");
          setMarkPaidOpen(false);
          await fetchWorklist();
        }
      }
    } finally {
      setMarkPaidBusy(false);
    }
  };

  // ---------------- Delete (owner only, soft) ----------------
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
      if (!res.ok) {
        toast.error(body.message ?? "Failed to delete");
      } else {
        toast.success(`Deleted ${body.data?.deletedCount ?? ids.length}`);
        setDeleteOpen(false);
        setSelected(new Set());
        await fetchWorklist();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  // ---------------- Export ----------------
  const exportExcel = async () => {
    if (!token || !activeBranchId) return;
    const params = new URLSearchParams();
    params.set("startDate", range.startDate);
    params.set("endDate", range.endDate + "T23:59:59.999Z");
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
    a.download = `payouts-${range.startDate}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const totals = worklist?.totals;

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 1440 }} className="pb-24">
        <OwnerPageHeader
          title="Payouts · Pay-Run"
          subtitle={`Settle everyone for the period · ${monthLabel}`}
          rightSlot={
            <>
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
              <RefreshButton isFetching={loading} onClick={fetchWorklist} />
            </>
          }
        />

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
                    Commission payouts
                  </div>
                  <DisplayNumber size={30}>
                    {formatRupees(totals?.commissionsPendingInPaise ?? 0)}
                  </DisplayNumber>
                  <div className="mt-1" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                    {(totals?.byType.REFERRAL.pendingCount ?? 0) +
                      (totals?.byType.CLINIC.pendingCount ?? 0) +
                      (totals?.byType.DIAGNOSTIC_CENTER.pendingCount ?? 0)}{" "}
                    pending
                  </div>
                </div>
                <div
                  className="md:border-l md:pl-4"
                  style={{ borderColor: TOKENS.border }}
                >
                  <div
                    className="mb-1.5 font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.caution }}
                  >
                    Outside-lab payables
                  </div>
                  <DisplayNumber size={30}>
                    <span style={{ color: TOKENS.caution }}>
                      {formatRupees(totals?.labPayablesPendingInPaise ?? 0)}
                    </span>
                  </DisplayNumber>
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
                      {formatRupees(
                        (totals?.byType[t].pendingAmountInPaise ?? 0)
                      )}
                    </span>{" "}
                    ({totals?.byType[t].pendingCount ?? 0})
                  </span>
                ))}
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
              <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                <SelectTrigger className="h-9 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative min-w-[180px] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search payee…"
                  className="h-9 pl-9"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
              </div>
              <Button variant="outline" size="sm" onClick={exportExcel}>
                Export Excel
              </Button>
            </div>

            {/* Grouped sections */}
            {groups.length === 0 ? (
              <SectionCard>
                <EmptyState
                  label="No payouts for this period"
                  hint="Try a different month, or use Run cycle to derive payouts."
                />
              </SectionCard>
            ) : (
              groups.map((g) => {
                const outbound = g.payeeType === "LAB";
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
                    <SectionCard
                      padding={0}
                      className=""
                      label={undefined}
                    >
                      <div
                        className="flex items-center gap-3 px-3 py-2"
                        style={{
                          background: outbound ? "#fbf7ee" : "#f6f5f2",
                          borderTopLeftRadius: 12,
                          borderTopRightRadius: 12,
                        }}
                      >
                        <span className="font-medium" style={{ fontSize: 12 }}>
                          {TYPE_LABEL[g.payeeType]}
                        </span>
                        <span className="ml-auto" style={{ fontSize: 12, color: TOKENS.textTertiary }}>
                          {g.rows.filter((r) => r.status === "PENDING").length} pending ·{" "}
                          <span
                            className="font-medium"
                            style={{ color: outbound ? TOKENS.caution : TOKENS.textPrimary }}
                          >
                            {formatRupees(g.pendingInPaise)}
                          </span>
                        </span>
                      </div>
                      <table className="w-full" style={{ fontSize: 12 }}>
                        <tbody>
                          {g.rows.map((r) => (
                            <tr key={r.id} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                              <td className="py-2 pl-3" style={{ width: 28 }}>
                                <input
                                  type="checkbox"
                                  checked={selected.has(r.id)}
                                  onChange={() => toggle(r.id)}
                                />
                              </td>
                              <td className="py-2">
                                {r.payeeName}{" "}
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
                              <td className="py-2 text-right" style={{ width: 90 }}>
                                <span
                                  className="font-medium"
                                  style={{
                                    fontSize: 11,
                                    color: r.status === "PAID" ? TOKENS.healthy : TOKENS.caution,
                                  }}
                                >
                                  {r.status === "PAID"
                                    ? r.paidAt
                                      ? `PAID`
                                      : "PAID"
                                    : outbound
                                      ? "UNPAID"
                                      : "PENDING"}
                                </span>
                              </td>
                              <td className="py-2 pr-3 text-right" style={{ width: 170 }}>
                                <button
                                  className="mr-2"
                                  style={{ color: TOKENS.info, fontSize: 12 }}
                                  onClick={() => navigate(`/owner/payouts/${r.id}`)}
                                >
                                  Statement
                                </button>
                                {r.status === "PENDING" && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7"
                                    onClick={() => openSingleMarkPaid(r)}
                                  >
                                    Mark Paid
                                  </Button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </SectionCard>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <PayoutBulkActionBar
        count={selected.size}
        totalInPaise={selectedTotalInPaise}
        isOwner={isOwner}
        onMarkPaid={openBulkMarkPaid}
        onDelete={() => isOwner && selected.size > 0 && setDeleteOpen(true)}
        onExport={exportExcel}
        onClear={() => setSelected(new Set())}
      />

      <PayoutMarkPaidDialog
        open={markPaidOpen}
        onOpenChange={setMarkPaidOpen}
        busy={markPaidBusy}
        payout={markPaidTarget}
        bulkCount={markPaidIsBulk ? selectedPending.length : 0}
        bulkTotalInPaise={
          markPaidIsBulk ? selectedPending.reduce((s, r) => s + r.amountInPaise, 0) : 0
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

export { PayoutsList };

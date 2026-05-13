import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Calculator,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  IndianRupee,
  PlayCircle,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { usePayoutPrefs } from "@/store/payoutPrefsStore";
import {
  usePayoutFiltersFromUrl,
  resolveDatePreset,
} from "@/lib/usePayoutFiltersFromUrl";
import { usePayoutSelection } from "@/lib/usePayoutSelection";
import { formatRupees } from "@/lib/payoutFormatters";
import {
  PayoutSummary,
  PayoutListResponse,
  PaymentType,
  PayoutDoctorType,
} from "@/types";
import { PayoutsTable } from "@/components/payouts/PayoutsTable";
import { PayoutBulkActionBar } from "@/components/payouts/PayoutBulkActionBar";
import { PayoutMarkPaidDialog } from "@/components/payouts/PayoutMarkPaidDialog";
import { PayoutDeleteDialog } from "@/components/payouts/PayoutDeleteDialog";
import { DatePresetChips } from "@/components/payouts/DatePresetChips";
import { PayoutsByDoctor } from "./PayoutsByDoctor";
import { PayoutRunCycle } from "./PayoutRunCycle";
import { DerivePayoutDialog } from "./DerivePayoutDialog";

// Default derive date range = last completed calendar month.
function lastCompletedMonth(): { startDate: string; endDate: string } {
  const today = new Date();
  const startDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const endDate = new Date(today.getFullYear(), today.getMonth(), 0);
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { startDate: ymd(startDate), endDate: ymd(endDate) };
}

export default function PayoutsList() {
  const { token, user } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();
  const isOwner = user?.role === "owner";

  const { state, update } = usePayoutFiltersFromUrl();
  const { pageSize: prefPageSize, setPageSize: setPrefPageSize } = usePayoutPrefs();

  // Effective date range — preset wins unless preset === "custom"
  const effectiveRange = useMemo(() => {
    if (state.preset === "custom") {
      return { startDate: state.startDate, endDate: state.endDate };
    }
    return resolveDatePreset(state.preset);
  }, [state.preset, state.startDate, state.endDate]);

  const effectivePageSize = state.pageSize > 0 ? state.pageSize : prefPageSize;

  // Local search input — debounced into URL state
  const [searchInput, setSearchInput] = useState(state.q);
  useEffect(() => setSearchInput(state.q), [state.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== state.q) update({ q: searchInput });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, state.q, update]);

  // ---------------- Data fetching ----------------
  const [list, setList] = useState<PayoutListResponse>({
    data: [],
    total: 0,
    page: 1,
    pageSize: effectivePageSize,
  });
  const [loading, setLoading] = useState(true);

  const [referralDoctors, setReferralDoctors] = useState<{ id: string; name: string }[]>([]);
  const [clinicDoctors, setClinicDoctors] = useState<{ id: string; name: string }[]>([]);
  const [diagnosticCenters, setDiagnosticCenters] = useState<{ id: string; name: string }[]>([]);

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": activeBranchId ?? "",
    "Content-Type": "application/json",
  });

  const fetchList = async () => {
    if (!token || !activeBranchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (state.doctorType !== "all") params.set("doctorType", state.doctorType);
      if (state.doctorId !== "all") params.set("doctorId", state.doctorId);
      if (state.status !== "all") params.set("isPaid", state.status === "paid" ? "true" : "false");
      if (effectiveRange.startDate) params.set("startDate", effectiveRange.startDate);
      if (effectiveRange.endDate) params.set("endDate", effectiveRange.endDate + "T23:59:59.999Z");
      if (state.q) params.set("q", state.q);
      params.set("page", String(state.page));
      params.set("pageSize", String(effectivePageSize));
      params.set("sortBy", state.sortBy);
      params.set("sortDir", state.sortDir);
      params.set("includeTotals", "true");

      const res = await fetch(`${API_BASE}/payouts?${params.toString()}`, {
        headers: headers(),
      });
      if (!res.ok) {
        toast.error("Failed to load payouts");
        return;
      }
      const data = (await res.json()) as PayoutListResponse;
      setList(data);
    } catch (err) {
      console.error(err);
      toast.error("Error loading payouts");
    } finally {
      setLoading(false);
    }
  };

  const fetchDoctors = async () => {
    if (!token || !activeBranchId) return;
    try {
      const opts = { headers: headers() };
      const [r, c, d] = await Promise.all([
        fetch(`${API_BASE}/payouts/doctors/referral`, opts),
        fetch(`${API_BASE}/payouts/doctors/clinic`, opts),
        fetch(`${API_BASE}/payouts/doctors/diagnostic-centers`, opts),
      ]);
      if (r.ok) setReferralDoctors(((await r.json()).data ?? []) as { id: string; name: string }[]);
      if (c.ok) setClinicDoctors(((await c.json()).data ?? []) as { id: string; name: string }[]);
      if (d.ok) setDiagnosticCenters(((await d.json()).data ?? []) as { id: string; name: string }[]);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchDoctors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeBranchId]);

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    token,
    activeBranchId,
    state.doctorType,
    state.doctorId,
    state.status,
    state.preset,
    state.startDate,
    state.endDate,
    state.q,
    state.page,
    state.pageSize,
    state.sortBy,
    state.sortDir,
  ]);

  // ---------------- Selection ----------------
  const selection = usePayoutSelection({ rows: list.data });

  // Selection clears when filters change (selection meaning becomes ambiguous).
  useEffect(() => {
    selection.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.doctorType, state.doctorId, state.status, state.preset, state.q]);

  const selectedRows = useMemo(
    () => list.data.filter((r) => selection.isSelected(r.id)),
    [list.data, selection]
  );
  const selectedTotalInPaise = useMemo(
    () => selectedRows.reduce((sum, r) => sum + r.derivedAmountInPaise, 0),
    [selectedRows]
  );
  const selectedAllPending = selectedRows.every((r) => !r.paidAt);

  // ---------------- Mark paid (single + bulk) ----------------
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidTarget, setMarkPaidTarget] = useState<PayoutSummary | null>(null);
  const [markPaidBusy, setMarkPaidBusy] = useState(false);
  const [markPaidIsBulk, setMarkPaidIsBulk] = useState(false);

  const openSingleMarkPaid = (row: PayoutSummary) => {
    setMarkPaidTarget(row);
    setMarkPaidIsBulk(false);
    setMarkPaidOpen(true);
  };
  const openBulkMarkPaid = () => {
    if (selectedRows.length === 0) return;
    if (!selectedAllPending) {
      toast.error("Selection includes already-paid payouts. Filter to Pending first.");
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
        const ids = selectedRows.filter((r) => !r.paidAt).map((r) => r.id);
        const res = await fetch(`${API_BASE}/payouts/mark-paid/bulk`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ ids, ...payment }),
        });
        const body = await res.json();
        if (!res.ok) {
          toast.error(body.message ?? "Failed to mark paid");
        } else {
          const r = body.data as {
            paidIds: string[];
            conflictIds: string[];
            notFoundIds: string[];
          };
          // notFoundIds = rows deleted by another session between selection and request.
          const parts: string[] = [`Marked ${r.paidIds.length} paid`];
          if (r.conflictIds.length) parts.push(`${r.conflictIds.length} already paid`);
          if (r.notFoundIds?.length)
            parts.push(`${r.notFoundIds.length} no longer exist`);
          toast.success(parts.join(" · "));
          setMarkPaidOpen(false);
          selection.clear();
          await fetchList();
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
          await fetchList();
        }
      }
    } finally {
      setMarkPaidBusy(false);
    }
  };

  // ---------------- Delete (owner-only, bulk) ----------------
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const openBulkDelete = () => {
    if (!isOwner) return;
    if (selectedRows.length === 0) return;
    setDeleteOpen(true);
  };

  const submitBulkDelete = async () => {
    if (!isOwner) return;
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
        const r = body.data as { deletedCount: number };
        // If deletedCount < what we selected, the remainder were already deleted
        // by another session (or out-of-branch — silently filtered server-side).
        const stale = selectedRows.length - r.deletedCount;
        toast.success(
          stale > 0
            ? `Deleted ${r.deletedCount} · ${stale} were already gone`
            : `Deleted ${r.deletedCount} ${r.deletedCount === 1 ? "payout" : "payouts"}`
        );
        setDeleteOpen(false);
        selection.clear();
        await fetchList();
      }
    } finally {
      setDeleteBusy(false);
    }
  };

  // ---------------- Export ----------------
  const exportFiltered = async () => {
    if (!token || !activeBranchId) return;
    const params = new URLSearchParams();
    if (state.doctorType !== "all") params.set("doctorType", state.doctorType);
    if (state.doctorId !== "all") params.set("doctorId", state.doctorId);
    if (state.status !== "all")
      params.set("isPaid", state.status === "paid" ? "true" : "false");
    if (effectiveRange.startDate) params.set("startDate", effectiveRange.startDate);
    if (effectiveRange.endDate)
      params.set("endDate", effectiveRange.endDate + "T23:59:59.999Z");
    if (state.q) params.set("q", state.q);
    params.set("sortBy", state.sortBy);
    params.set("sortDir", state.sortDir);

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
    a.download = `payouts-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ---------------- Filter dropdown options ----------------
  const filterDoctorOptions = useMemo(() => {
    if (state.doctorType === "REFERRAL") return referralDoctors;
    if (state.doctorType === "CLINIC") return clinicDoctors;
    if (state.doctorType === "DIAGNOSTIC_CENTER") return diagnosticCenters;
    return [
      ...referralDoctors.map((d) => ({ id: d.id, name: `${d.name} (Referral)` })),
      ...clinicDoctors.map((d) => ({ id: d.id, name: `${d.name} (Clinic)` })),
      ...diagnosticCenters.map((d) => ({ id: d.id, name: `${d.name} (Center)` })),
    ];
  }, [state.doctorType, referralDoctors, clinicDoctors, diagnosticCenters]);

  // ---------------- Run Cycle / Single Derive ----------------
  const [runCycleOpen, setRunCycleOpen] = useState(false);
  const [singleDeriveOpen, setSingleDeriveOpen] = useState(false);

  const openRunCycle = () => {
    if (!isOwner && user?.role !== "staff") return;
    setRunCycleOpen(true);
  };

  // ---------------- Pagination ----------------
  const totalPages = Math.max(1, Math.ceil(list.total / effectivePageSize));

  // If a refetch returned fewer pages than the URL says we're on (e.g. after a
  // bulk delete shrunk the result set), snap to the last valid page so the
  // user doesn't stare at "Page 5 of 4" + an empty table until they reload.
  useEffect(() => {
    if (loading) return;
    if (list.total === 0) return;
    if (state.page > totalPages) {
      update({ page: totalPages });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, list.total, totalPages, state.page]);

  // ---------------- Render ----------------
  return (
    <AppLayout context="owner" subContext="payouts">
      <div className="space-y-6 pb-24">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
            <p className="text-gray-500">
              Commissions for referral doctors, clinic doctors, and diagnostic centers
            </p>
          </div>
          {(isOwner || user?.role === "staff") && (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setSingleDeriveOpen(true)}>
                <Calculator className="h-4 w-4 mr-2" />
                Single Payout
              </Button>
              <Button onClick={openRunCycle}>
                <PlayCircle className="h-4 w-4 mr-2" />
                Run Monthly Cycle
              </Button>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="relative max-w-xl">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by doctor name or payment reference"
            className="pl-9"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {/* Date presets */}
        <div className="flex flex-wrap items-center gap-3">
          <DatePresetChips
            value={state.preset}
            onChange={(p) => update({ preset: p })}
          />
          {state.preset === "custom" && (
            <div className="flex items-center gap-2">
              <Input
                type="date"
                value={state.startDate}
                onChange={(e) => update({ startDate: e.target.value })}
                className="w-40"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="date"
                value={state.endDate}
                onChange={(e) => update({ endDate: e.target.value })}
                className="w-40"
              />
            </div>
          )}
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-44">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select
              value={state.doctorType}
              onValueChange={(v) =>
                update({
                  doctorType: v as PayoutDoctorType | "all",
                  doctorId: "all",
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="REFERRAL">Referral Doctors</SelectItem>
                <SelectItem value="CLINIC">Clinic Doctors</SelectItem>
                <SelectItem value="DIAGNOSTIC_CENTER">Diagnostic Centers</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-72">
            <Label className="text-xs text-muted-foreground">Doctor / Center</Label>
            <SearchableSelect
              value={state.doctorId === "all" ? "" : state.doctorId}
              onValueChange={(v) => update({ doctorId: v || "all" })}
              options={[
                { value: "all", label: "All doctors / centers" },
                ...filterDoctorOptions.map((d) => ({ value: d.id, label: d.name })),
              ]}
              placeholder="All doctors / centers"
              searchPlaceholder="Type to search…"
              emptyText="No matches"
            />
          </div>

          <div className="w-36">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select
              value={state.status}
              onValueChange={(v) =>
                update({ status: v as "all" | "pending" | "paid" })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="paid">Paid</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button variant="outline" onClick={exportFiltered} className="ml-auto">
            Export Excel
          </Button>
        </div>

        {/* Summary Cards (server-side totals — match the filtered set) */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard
            label="Pending Payouts"
            value={list.totals?.pendingCount ?? 0}
            icon={<Clock className="h-5 w-5 text-yellow-600" />}
            tint="bg-yellow-100"
            loading={loading}
          />
          <SummaryCard
            label="Pending Amount"
            value={formatRupees(list.totals?.pendingAmountInPaise ?? 0)}
            icon={<IndianRupee className="h-5 w-5 text-red-600" />}
            tint="bg-red-100"
            loading={loading}
          />
          <SummaryCard
            label="Paid Payouts"
            value={list.totals?.paidCount ?? 0}
            icon={<Check className="h-5 w-5 text-green-600" />}
            tint="bg-green-100"
            loading={loading}
          />
          <SummaryCard
            label="Total Paid"
            value={formatRupees(list.totals?.paidAmountInPaise ?? 0)}
            icon={<IndianRupee className="h-5 w-5 text-blue-600" />}
            tint="bg-blue-100"
            loading={loading}
          />
        </div>

        {/* Tabs */}
        <Tabs
          value={state.tab}
          onValueChange={(v) =>
            update({ tab: v as "by-period" | "by-doctor" })
          }
        >
          <TabsList>
            <TabsTrigger value="by-period">By Period</TabsTrigger>
            <TabsTrigger value="by-doctor">By Doctor</TabsTrigger>
          </TabsList>

          <TabsContent value="by-period" className="mt-4">
            <Card>
              <CardContent className="pt-6">
                {!loading && list.data.length === 0 ? (
                  <EmptyState hasFilters={hasActiveFilters(state)} />
                ) : (
                  <>
                    <PayoutsTable
                      rows={list.data}
                      loading={loading}
                      selection={selection}
                      sortBy={state.sortBy}
                      sortDir={state.sortDir}
                      onSortChange={(field) =>
                        update({
                          sortBy: field,
                          sortDir:
                            state.sortBy === field && state.sortDir === "desc"
                              ? "asc"
                              : "desc",
                        })
                      }
                      onRowClick={(r) => navigate(`/owner/payouts/${r.id}`)}
                      onMarkPaid={openSingleMarkPaid}
                    />

                    {/* Pagination + page-size selector */}
                    {list.total > 0 && (
                      <div className="flex items-center justify-between mt-4 pt-4 border-t">
                        <div className="flex items-center gap-3">
                          <p className="text-sm text-muted-foreground">
                            {(list.page - 1) * list.pageSize + 1}–
                            {Math.min(list.page * list.pageSize, list.total)} of{" "}
                            {list.total}
                          </p>
                          <Select
                            value={String(effectivePageSize)}
                            onValueChange={(v) => {
                              const n = Number(v);
                              setPrefPageSize(n);
                              update({ pageSize: n, page: 1 });
                            }}
                          >
                            <SelectTrigger className="h-8 w-24">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="25">25</SelectItem>
                              <SelectItem value="50">50</SelectItem>
                              <SelectItem value="100">100</SelectItem>
                              <SelectItem value="200">200</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={list.page <= 1}
                            onClick={() => update({ page: list.page - 1 })}
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <span className="text-sm">
                            Page {list.page} of {totalPages}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={list.page >= totalPages}
                            onClick={() => update({ page: list.page + 1 })}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="by-doctor" className="mt-4">
            <PayoutsByDoctor
              filters={{
                doctorType: state.doctorType,
                startDate: effectiveRange.startDate,
                endDate: effectiveRange.endDate,
                q: state.q,
              }}
              isOwner={isOwner}
              onOpenDoctor={(doctorId, doctorType) =>
                update({
                  tab: "by-period",
                  doctorId,
                  doctorType,
                })
              }
              refreshKey={list.total}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Bulk action bar */}
      <PayoutBulkActionBar
        count={selection.selectedCount}
        totalInPaise={selectedTotalInPaise}
        isOwner={isOwner}
        onMarkPaid={openBulkMarkPaid}
        onDelete={openBulkDelete}
        onExport={exportFiltered}
        onClear={selection.clear}
      />

      <PayoutMarkPaidDialog
        open={markPaidOpen}
        onOpenChange={setMarkPaidOpen}
        busy={markPaidBusy}
        payout={markPaidTarget}
        bulkCount={markPaidIsBulk ? selectedRows.filter((r) => !r.paidAt).length : 0}
        bulkTotalInPaise={
          markPaidIsBulk
            ? selectedRows
                .filter((r) => !r.paidAt)
                .reduce((s, r) => s + r.derivedAmountInPaise, 0)
            : 0
        }
        onConfirm={submitMarkPaid}
      />

      <PayoutDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        count={selectedRows.length}
        busy={deleteBusy}
        onConfirm={submitBulkDelete}
      />

      {(isOwner || user?.role === "staff") && (
        <DerivePayoutDialog
          open={singleDeriveOpen}
          onOpenChange={setSingleDeriveOpen}
          referralDoctors={referralDoctors}
          clinicDoctors={clinicDoctors}
          diagnosticCenters={diagnosticCenters}
          defaultRange={lastCompletedMonth()}
          onDerived={async () => {
            setSingleDeriveOpen(false);
            await fetchList();
          }}
        />
      )}

      {(isOwner || user?.role === "staff") && (
        <PayoutRunCycle
          open={runCycleOpen}
          onOpenChange={setRunCycleOpen}
          onCompleted={async () => {
            setRunCycleOpen(false);
            await fetchList();
          }}
        />
      )}
    </AppLayout>
  );
}

// ---------------- Helpers ----------------

function hasActiveFilters(state: ReturnType<typeof usePayoutFiltersFromUrl>["state"]) {
  return (
    state.doctorType !== "all" ||
    state.doctorId !== "all" ||
    state.status !== "all" ||
    state.q !== "" ||
    state.preset !== "this-month"
  );
}

function SummaryCard(props: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  tint: string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className={`p-2 ${props.tint} rounded-lg`}>{props.icon}</div>
          <div className="min-w-0">
            <p className="text-sm text-gray-500">{props.label}</p>
            {props.loading ? (
              <Skeleton className="h-7 w-20" />
            ) : (
              <p className="text-xl font-semibold truncate">{props.value}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  if (hasFilters) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">No payouts match your filters.</p>
        <p className="text-sm text-muted-foreground mt-1">
          Try widening the date range or clearing filters.
        </p>
      </div>
    );
  }
  return (
    <div className="text-center py-12">
      <p className="text-muted-foreground">No payouts yet.</p>
      <p className="text-sm text-muted-foreground mt-1">
        Use <strong>Run Monthly Cycle</strong> to derive payouts for an entire month at once.
      </p>
    </div>
  );
}

// Eager imports above for siblings; kept named so PayoutsList stays the default.
export { PayoutsList };

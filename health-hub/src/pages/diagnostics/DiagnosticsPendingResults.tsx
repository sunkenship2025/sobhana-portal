import { useState, useMemo, useEffect, useCallback } from "react";
import { API_BASE } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/ui/page-header";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranchStore } from "@/store/branchStore";
import { useAuthStore } from "@/store/authStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { toast } from "sonner";
import { CheckCheck, Clock, Search, Phone, Stethoscope } from "lucide-react";
import { searchWorklist } from "@/lib/worklistSearch";
import { usePagedList } from "@/hooks/usePagedList";
import { useRevalidateOnFocus } from "@/hooks/useRevalidateOnFocus";
import { DateRangeFilter } from "@/components/worklist/DateRangeFilter";
import {
  type DateRangeState,
  makeDateRange,
  matchesDateRange,
  dateRangeKey,
} from "@/lib/dateFilter";
import { WorklistPager } from "@/components/worklist/WorklistPager";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatPatientName, compactAge, formatRefDoctor, formatCurrency } from '@/lib/patientDisplay';
import { formatPaymentModes } from '@/lib/paymentDisplay';

type PaymentType = "CASH" | "ONLINE";

const toSupportedPaymentType = (value: unknown): PaymentType => {
  if (value === "ONLINE") return "ONLINE";
  return "CASH";
};

// Collapse a list of test orders into a readable summary for the visit row.
// Bill-only orders are hidden (they don't ship in a report). Orders collapse
// to the BILLED PRODUCT — so a Complete Blood Picture ordered as 13 sub-tests
// shows as "COMPLETE BLOOD PICTURE" once, matching exactly what was billed.
// This is immune to stray per-test panel mappings (a constituent mis-tagged to
// another panel can no longer leak a phantom name like "HEMOGRAM"). Orders with
// no product fall back to their panel name, then the test name.
const formatTestList = (
  testOrders: Array<{
    workflowMode?: string;
    cancelledAt?: string | null;
    noReportAt?: string | null;
    testName?: string;
    testCode?: string;
    productId?: string | null;
    productName?: string | null;
    panel?: { id: string; name: string; displayName?: string } | null;
  }>,
): string => {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const order of testOrders) {
    if (order.workflowMode === "BILL_ONLY") continue;
    if (order.cancelledAt) continue; // voided — never performed, so never listed
    if (order.noReportAt) continue; // closed as "no report needed" — off the worklist
    let key: string;
    let label: string;
    if (order.productId) {
      key = `product:${order.productId}`;
      label =
        order.productName ||
        order.panel?.displayName ||
        order.panel?.name ||
        order.testName ||
        order.testCode ||
        "";
    } else {
      const panel = order.panel;
      key = panel?.id ? `panel:${panel.id}` : `test:${order.testCode || order.testName || ""}`;
      label = panel?.displayName || panel?.name || order.testName || order.testCode || "";
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (label) labels.push(label);
  }
  return labels.join(", ");
};

// Same collapse as formatTestList, but carries per-billed-item readiness so the
// worklist can colour each test green (results in) or amber (still pending). A
// collapsed item counts as ready only when every constituent order is ready
// (e.g. a 13-parameter CBP isn't "done" until all its results are entered).
const buildTestTokens = (
  testOrders: Array<{
    workflowMode?: string;
    cancelledAt?: string | null;
    noReportAt?: string | null;
    testName?: string;
    testCode?: string;
    productId?: string | null;
    productName?: string | null;
    resultReady?: boolean | null;
    panel?: { id: string; name: string; displayName?: string } | null;
  }>,
): Array<{ label: string; ready: boolean }> => {
  const map = new Map<string, { label: string; ready: boolean }>();
  for (const order of testOrders) {
    if (order.workflowMode === "BILL_ONLY") continue;
    if (order.cancelledAt) continue; // voided — never performed, so never listed
    if (order.noReportAt) continue; // closed as "no report needed" — off the worklist
    let key: string;
    let label: string;
    if (order.productId) {
      key = `product:${order.productId}`;
      label =
        order.productName ||
        order.panel?.displayName ||
        order.panel?.name ||
        order.testName ||
        order.testCode ||
        "";
    } else {
      const panel = order.panel;
      key = panel?.id ? `panel:${panel.id}` : `test:${order.testCode || order.testName || ""}`;
      label = panel?.displayName || panel?.name || order.testName || order.testCode || "";
    }
    if (!label) continue;
    const ready = order.resultReady === true;
    const existing = map.get(key);
    if (existing) {
      existing.ready = existing.ready && ready;
    } else {
      map.set(key, { label, ready });
    }
  }
  return [...map.values()];
};

// Compact "billed at" label, e.g. "9 Jul, 2:05 PM".
const formatBilledAt = (value?: string | null): string => {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const DiagnosticsPendingResults = () => {
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  const [dateRange, setDateRange] = useState<DateRangeState>(makeDateRange("all"));
  const [search, setSearch] = useState("");
  const [pendingVisits, setPendingVisits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dueVisit, setDueVisit] = useState<any | null>(null);
  const [collectAmount, setCollectAmount] = useState("");
  const [collectPaymentType, setCollectPaymentType] =
    useState<PaymentType>("CASH");
  const [collectingDue, setCollectingDue] = useState(false);
  const [collectSuccessId, setCollectSuccessId] = useState<string | null>(null);
  // Optional discount applied while collecting the due. Mirrors the new-visit
  // discount control; the reason is mandatory when a discount is entered.
  const [collectDiscountMode, setCollectDiscountMode] = useState<
    "NONE" | "PERCENTAGE" | "FLAT_AMOUNT"
  >("NONE");
  const [collectDiscountValue, setCollectDiscountValue] = useState("");
  const [collectDiscountReason, setCollectDiscountReason] = useState("");

  const resetCollectDiscount = () => {
    setCollectDiscountMode("NONE");
    setCollectDiscountValue("");
    setCollectDiscountReason("");
  };

  const formatMoneyFromPaise = (amountInPaise?: number | null) =>
    `₹${((amountInPaise ?? 0) / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  // Fetch pending visits from API (DRAFT and WAITING status). `silent` skips the
  // full-page spinner so background revalidation swaps data in place.
  const fetchPendingVisits = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!token || !activeBranchId) return;
      try {
        if (!silent) setLoading(true);
        // Fetch DRAFT visits (no results entered yet) and WAITING visits (results saved but not finalized)
        const [draftRes, waitingRes] = await Promise.all([
          fetch(`${API_BASE}/visits/diagnostic?status=DRAFT`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranchId,
            },
          }),
          fetch(`${API_BASE}/visits/diagnostic?status=WAITING`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranchId,
            },
          }),
        ]);

        const draftData = draftRes.ok ? await draftRes.json() : [];
        const waitingData = waitingRes.ok ? await waitingRes.json() : [];

        // Combine and sort by createdAt
        const combined = [...draftData, ...waitingData].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        setPendingVisits(combined);
      } catch (error) {
        console.error("Failed to fetch pending visits:", error);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token, activeBranchId],
  );

  useEffect(() => {
    void fetchPendingVisits();
  }, [fetchPendingVisits]);

  // Revalidate when the staff return to a stale tab (counter phones keep this
  // page open for hours) so the queue count never lags behind new bills.
  useRevalidateOnFocus(() => void fetchPendingVisits({ silent: true }), {
    enabled: Boolean(token && activeBranchId),
    pollMs: 60_000,
  });

  // Build view data from API response
  const visitsWithDetails = useMemo(() => {
    return pendingVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: visit.patient, // API response includes patient data
        testOrders: visit.testOrders || [], // API response includes test orders
      }));
  }, [pendingVisits, activeBranchId]);

  const filteredVisits = useMemo(() => {
    const base = visitsWithDetails.filter(({ visit }) => {
      // Include both REPORTABLE and EXTERNAL_UPLOAD visits — both land on the entry screen.
      const hasInclusion =
        visit.hasReportInclusionOrders ??
        (visit.hasReportableOrders || visit.hasExternalUploadOrders);
      if (!hasInclusion || visit.nextAction !== "ENTER_RESULTS") {
        return false;
      }

      return matchesDateRange(dateRange, visit.createdAt);
    });

    // Ranked, case-insensitive, phone-format-agnostic search (exact name first);
    // returns `base` unchanged when the search box is empty.
    return searchWorklist(base, search, ({ patient, visit }) => ({
      name: patient?.name,
      phone: patient?.identifiers?.find((id: any) => id.type === "PHONE")?.value,
      billNumber: visit.billNumber,
    }));
  }, [visitsWithDetails, dateRange, search]);

  const paged = usePagedList(filteredVisits, `${search}|${dateRangeKey(dateRange)}`);

  // Whether any case is actually result-entry-eligible (passes the domain gate
  // above), independent of date/search. Lets the empty state tell "nothing to
  // do" apart from "filters hid everything" — and guarantees that, when shown,
  // "Clear filters" will surface at least one row.
  const hasDisplayablePending = useMemo(
    () =>
      visitsWithDetails.some(({ visit }) => {
        const hasInclusion =
          visit.hasReportInclusionOrders ??
          (visit.hasReportableOrders || visit.hasExternalUploadOrders);
        return hasInclusion && visit.nextAction === "ENTER_RESULTS";
      }),
    [visitsWithDetails],
  );

  const handleAction = (visit: any) => {
    navigate(`/diagnostics/results/${visit.id}`);
  };

  // The additional discount (in paise) entered in the dialog, and the resulting
  // preview of Discount / Net / Balance so the operator sees the effect live.
  const collectPreview = useMemo(() => {
    if (!dueVisit) return null;
    const totalPaise = Math.round((dueVisit.totalAmount ?? 0) * 100);
    const existingDiscountPaise = dueVisit.discountAmountInPaise ?? 0;
    const netPaise = dueVisit.netAmountInPaise ?? 0;
    const paidPaise = dueVisit.paidAmountInPaise ?? 0;
    const value = Number(collectDiscountValue);
    const active =
      collectDiscountMode !== "NONE" && Number.isFinite(value) && value > 0;
    const incrementPaise = !active
      ? 0
      : collectDiscountMode === "PERCENTAGE"
        ? Math.round((totalPaise * Math.min(100, value)) / 100)
        : Math.round(value * 100);
    const discountPaise = Math.min(totalPaise, existingDiscountPaise + incrementPaise);
    const netPreview = Math.max(0, netPaise - incrementPaise);
    const duePreview = Math.max(0, netPreview - paidPaise);
    return {
      active,
      discountPaise,
      netPreview,
      duePreview,
      // The discount is bigger than the remaining balance — the patient has
      // already paid more than the new net, so a refund is needed first.
      tooLarge: incrementPaise > 0 && netPreview < paidPaise,
    };
  }, [dueVisit, collectDiscountMode, collectDiscountValue]);

  // Keep "Collect Now" defaulted to the balance after the entered discount, so
  // the common case (collect the reduced balance) needs no manual retyping.
  const syncCollectAmountToDiscount = (
    mode: typeof collectDiscountMode,
    rawValue: string,
  ) => {
    if (!dueVisit) return;
    const totalPaise = Math.round((dueVisit.totalAmount ?? 0) * 100);
    const netPaise = dueVisit.netAmountInPaise ?? 0;
    const paidPaise = dueVisit.paidAmountInPaise ?? 0;
    const value = Number(rawValue);
    const incrementPaise =
      mode !== "NONE" && Number.isFinite(value) && value > 0
        ? mode === "PERCENTAGE"
          ? Math.round((totalPaise * Math.min(100, value)) / 100)
          : Math.round(value * 100)
        : 0;
    const duePreview = Math.max(0, Math.max(0, netPaise - incrementPaise) - paidPaise);
    setCollectAmount(duePreview > 0 ? String(duePreview / 100) : "0");
  };

  const openCollectDue = (visit: any) => {
    const firstPaymentType =
      typeof visit.paymentType === "string"
        ? visit.paymentType.split(",")[0]?.trim()
        : undefined;

    setDueVisit(visit);
    resetCollectDiscount();
    setCollectAmount(
      visit.dueAmountInPaise ? String(visit.dueAmountInPaise / 100) : "",
    );
    setCollectPaymentType(toSupportedPaymentType(firstPaymentType));
  };

  const handleCollectDue = async () => {
    if (!dueVisit) return;

    const discountActive = collectDiscountMode !== "NONE";
    const discountVal = Number(collectDiscountValue);
    if (discountActive) {
      if (!Number.isFinite(discountVal) || discountVal <= 0) {
        toast.error("Enter a valid discount");
        return;
      }
      if (!collectDiscountReason.trim()) {
        toast.error("A reason is required to apply a discount");
        return;
      }
      if (collectPreview?.tooLarge) {
        toast.error(
          "Discount is larger than the remaining balance — refund the overpaid amount first",
        );
        return;
      }
    }

    const amount = Number(collectAmount);
    // A discount that clears the whole balance can be applied with no collection.
    const isWaiver = discountActive && (collectPreview?.duePreview ?? 1) === 0;
    if (!isWaiver && (!Number.isFinite(amount) || amount <= 0)) {
      toast.error("Enter a valid collection amount");
      return;
    }

    setCollectingDue(true);
    try {
      const response = await fetch(
        `${API_BASE}/visits/diagnostic/${dueVisit.id}/collect-due`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Branch-Id": activeBranchId,
          },
          body: JSON.stringify({
            amount: isWaiver ? 0 : amount,
            paymentType: collectPaymentType,
            ...(discountActive
              ? {
                  discountType: collectDiscountMode,
                  discountValue: discountVal,
                  discountReason: collectDiscountReason.trim(),
                }
              : {}),
          }),
        },
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to collect due");
      }

      setPendingVisits((prev) =>
        prev.map((visit) =>
          visit.id === dueVisit.id
            ? {
                ...visit,
                paymentType: data.paymentType,
                paymentBreakdown: data.paymentBreakdown,
                paymentStatus: data.paymentStatus,
                discountType: data.discountType,
                discountPercentage: data.discountPercentage,
                discountAmountInPaise: data.discountAmountInPaise,
                discountReason: data.discountReason,
                couponDiscountInPaise: (data as any).couponDiscountInPaise,
                couponCode: (data as any).couponCode,
                paidAmountInPaise: data.paidAmountInPaise,
                netAmountInPaise: data.netAmountInPaise,
                dueAmountInPaise: data.dueAmountInPaise,
              }
            : visit,
        ),
      );
      toast.success(
        discountActive ? "Discount applied & payment collected" : "Due payment collected",
      );
      setCollectSuccessId(dueVisit.id);
    } catch (error: any) {
      toast.error(error.message || "Failed to collect due");
    } finally {
      setCollectingDue(false);
    }
  };

  if (loading) {
    return (
      <AppLayout context="diagnostics">
        <LoadingState />
      </AppLayout>
    );
  }

  return (
    <AppLayout context="diagnostics">
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Pending Results" subtitle="Which lab cases still need results entered?" />

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <DateRangeFilter
                value={dateRange}
                onChange={setDateRange}
                triggerClassName="w-full sm:w-[180px]"
              />
              <div className="space-y-2 w-full flex-1 sm:max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Name / Phone / Bill Number"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Result Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-warning" />
              Result Queue ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {hasDisplayablePending ? (
                    <Search className="h-5 w-5" />
                  ) : (
                    <Clock className="h-5 w-5" />
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {hasDisplayablePending
                      ? 'No pending results match your filters'
                      : 'All caught up'}
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {hasDisplayablePending
                      ? 'Try a different date range, or clear the search to see every pending case.'
                      : 'No lab cases are waiting for results right now. New cases appear here once a diagnostic bill is created.'}
                  </p>
                </div>
                {hasDisplayablePending && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setDateRange(makeDateRange('all'));
                      setSearch('');
                    }}
                  >
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {paged.pageItems.map(({ visit, patient, testOrders }) => {
                  const p: any = patient || {};
                  const ageStr = compactAge(p);
                  const genderStr = p.gender || "";
                  const phoneVal =
                    p.identifiers?.find((id: any) => id.type === "PHONE")?.value || "";
                  const refName = formatRefDoctor((visit as any).referralDoctor?.name);
                  const billedAtStr = formatBilledAt(
                    (visit as any).billedAt || (visit as any).createdAt,
                  );
                  const paidModes = formatPaymentModes(
                    visit.paymentBreakdown,
                    visit.paymentType,
                  );
                  return (
                  <div
                    key={visit.id}
                    className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {formatPatientName(patient?.name || "Unknown", (patient as any).title)}
                        </span>
                        {(ageStr || genderStr) && (
                          <span className="text-muted-foreground">
                            {ageStr}
                            {ageStr && genderStr ? " | " : ""}
                            {genderStr}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span>
                          Bill #:{" "}
                          <span className="font-mono">{visit.billNumber}</span>
                        </span>
                        {billedAtStr && (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            {billedAtStr}
                          </span>
                        )}
                        {phoneVal && (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5 shrink-0" />
                            {phoneVal}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <Stethoscope className="h-3.5 w-3.5 shrink-0" />
                          {refName}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        {(visit.readyReportInclusionCount ?? 0) > 0 ? (
                          <span className="text-muted-foreground">
                            Tests:{" "}
                            {buildTestTokens(testOrders).map((t, i, arr) => (
                              <span key={t.label}>
                                <span
                                  className={
                                    t.ready
                                      ? "text-emerald-700"
                                      : "font-medium text-amber-700"
                                  }
                                >
                                  {t.label}
                                </span>
                                {i < arr.length - 1 ? ", " : ""}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Tests: {formatTestList(testOrders)}
                          </span>
                        )}
                        {visit.hasBillOnlyOrders &&
                          (visit.hasReportInclusionOrders ??
                            (visit.hasReportableOrders ||
                              visit.hasExternalUploadOrders)) && (
                            <span className="text-amber-700">
                              Includes bill-only items
                            </span>
                          )}
                        {(visit.paidAmountInPaise ?? 0) > 0 && (
                          <span className="text-muted-foreground">
                            Paid: {formatCurrency(visit.paidAmountInPaise)}
                            {paidModes ? ` · ${paidModes}` : ""}
                          </span>
                        )}
                        {(visit.dueAmountInPaise ?? 0) > 0 && (
                          <span className="font-medium text-amber-700">
                            Balance due: {formatMoneyFromPaise(visit.dueAmountInPaise)}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {visit.hasPartialReport ? (
                          <span className="status-badge status-pending inline-flex items-center gap-1">
                            <CheckCheck className="h-3 w-3" />
                            Partial sent
                          </span>
                        ) : (visit.readyReportInclusionCount ?? 0) > 0 ? (
                          <span className="status-badge status-pending">
                            In progress
                          </span>
                        ) : (
                          <StatusBadge status={visit.status} />
                        )}
                        {(visit.reportInclusionCount ?? 0) > 0 &&
                          (visit.readyReportInclusionCount ?? 0) > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {visit.readyReportInclusionCount} of{" "}
                              {visit.reportInclusionCount} ready
                            </span>
                          )}
                      </div>
                    </div>
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                      {(visit.dueAmountInPaise ?? 0) > 0 && (
                        <Button
                          className="w-full sm:w-auto"
                          variant="outline"
                          onClick={() => openCollectDue(visit)}
                        >
                          Collect Due
                        </Button>
                      )}
                      <Button
                        className="w-full sm:w-auto"
                        onClick={() => handleAction(visit)}
                      >
                        Enter Results
                      </Button>
                    </div>
                  </div>
                  );
                })}
                <WorklistPager
                  page={paged.page}
                  totalPages={paged.totalPages}
                  hasPrev={paged.hasPrev}
                  hasNext={paged.hasNext}
                  onPrev={paged.prev}
                  onNext={paged.next}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={Boolean(dueVisit)}
          onOpenChange={(open) => {
            if (!open) {
              setDueVisit(null);
              setCollectSuccessId(null);
              setCollectAmount("");
              resetCollectDiscount();
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {collectSuccessId ? "Payment Collected" : "Collect Due"}
              </DialogTitle>
            </DialogHeader>
            {dueVisit && !collectSuccessId && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total</span>
                    <span>
                      {formatMoneyFromPaise(
                        Math.round((dueVisit.totalAmount ?? 0) * 100),
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount</span>
                    <span>
                      -
                      {formatMoneyFromPaise(
                        collectPreview?.discountPaise ??
                          dueVisit.discountAmountInPaise,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Net payable</span>
                    <span>
                      {formatMoneyFromPaise(
                        collectPreview?.netPreview ?? dueVisit.netAmountInPaise,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Already paid</span>
                    <span>
                      {formatMoneyFromPaise(dueVisit.paidAmountInPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold text-amber-700">
                    <span>Balance due</span>
                    <span>
                      {formatMoneyFromPaise(
                        collectPreview?.duePreview ?? dueVisit.dueAmountInPaise,
                      )}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Discount</Label>
                  <div className="grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
                    <Select
                      value={collectDiscountMode}
                      onValueChange={(value) => {
                        const mode = value as typeof collectDiscountMode;
                        setCollectDiscountMode(mode);
                        setCollectDiscountValue("");
                        setCollectDiscountReason("");
                        syncCollectAmountToDiscount(mode, "");
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">No discount</SelectItem>
                        <SelectItem value="PERCENTAGE">Percent %</SelectItem>
                        <SelectItem value="FLAT_AMOUNT">Amount ₹</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="text"
                      inputMode="numeric"
                      value={collectDiscountValue}
                      onChange={(e) => {
                        setCollectDiscountValue(e.target.value);
                        syncCollectAmountToDiscount(
                          collectDiscountMode,
                          e.target.value,
                        );
                      }}
                      placeholder={
                        collectDiscountMode === "PERCENTAGE"
                          ? "Enter discount %"
                          : "Enter discount amount"
                      }
                      disabled={collectDiscountMode === "NONE"}
                    />
                  </div>
                  {collectDiscountMode !== "NONE" && (
                    <Input
                      placeholder="Reason for discount (Required)"
                      value={collectDiscountReason}
                      onChange={(e) => setCollectDiscountReason(e.target.value)}
                    />
                  )}
                  {collectPreview?.tooLarge && (
                    <p className="text-xs text-destructive">
                      Discount is larger than the remaining balance. Refund the
                      overpaid amount first.
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>Collect Now (₹)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={(collectPreview?.duePreview ?? dueVisit.dueAmountInPaise ?? 0) / 100}
                    step="1"
                    value={collectAmount}
                    onChange={(e) => setCollectAmount(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Payment Type</Label>
                  <Select
                    value={collectPaymentType}
                    onValueChange={(value) =>
                      setCollectPaymentType(value as PaymentType)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CASH">Cash</SelectItem>
                      <SelectItem value="ONLINE">Online</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {dueVisit && collectSuccessId && (
              <div className="space-y-4 py-4 text-center">
                <div className="text-muted-foreground mb-4">
                  Payment recorded successfully. You can now print the updated
                  bill.
                </div>
                <Button
                  className="w-full"
                  onClick={() =>
                    window.open(
                      `/bill/print/DIAGNOSTICS/${collectSuccessId}`,
                      "_blank",
                    )
                  }
                >
                  Print Updated Bill
                </Button>
              </div>
            )}
            <DialogFooter>
              {!collectSuccessId ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDueVisit(null);
                      resetCollectDiscount();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCollectDue}
                    disabled={collectingDue || !collectAmount}
                  >
                    {collectingDue ? "Collecting..." : "Collect Payment"}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDueVisit(null);
                    setCollectSuccessId(null);
                    setCollectAmount("");
                    resetCollectDiscount();
                  }}
                >
                  Close
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
};

export default DiagnosticsPendingResults;

import { useState, useMemo, useEffect, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/loading-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { toast } from 'sonner';
import { CheckCircle2, Search, Eye, Printer, MessageCircle, Phone, Stethoscope, Receipt } from 'lucide-react';
import { openFinalizedReportWindow } from '@/lib/reportAccess';
import { formatPatientName, compactAge, formatRefDoctor, formatCurrency } from '@/lib/patientDisplay';
import { formatPaymentModes } from '@/lib/paymentDisplay';
import { cn } from '@/lib/utils';
import { useRevalidateOnFocus } from '@/hooks/useRevalidateOnFocus';
import { DateRangeFilter } from '@/components/worklist/DateRangeFilter';
import {
  type DateRangeState,
  makeDateRange,
  matchesDateRange,
  dateRangeKey,
  dateRangeFrom,
} from '@/lib/dateFilter';
import { searchWorklist } from '@/lib/worklistSearch';
import { usePagedList } from '@/hooks/usePagedList';
import { WorklistPager } from '@/components/worklist/WorklistPager';

// Collapse a list of test orders into a readable summary for the visit row.
// Bill-only orders are hidden (they don't ship in a report). Orders that
// belong to a panel collapse to a single entry per panel — so a Hemogram
// ordered with 10 sub-tests shows as "HEMOGRAM" once, not 10 codes.
const formatTestList = (
  testOrders: Array<{
    workflowMode?: string;
    testName?: string;
    testCode?: string;
    panel?: { id: string; name: string; displayName?: string } | null;
  }>,
): string => {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const order of testOrders) {
    if (order.workflowMode === 'BILL_ONLY') continue;
    const panel = order.panel;
    const key = panel?.id ? `panel:${panel.id}` : `test:${order.testCode || order.testName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label =
      panel?.displayName || panel?.name || order.testName || order.testCode || '';
    if (label) labels.push(label);
  }
  return labels.join(', ');
};

// Bill-only visits carry no reportable tests, so formatTestList() returns ''.
// Fall back to the bill-only product names ("USG Abdomen (Bill)") so the row
// still says what was billed.
const formatBillOnlyList = (
  testOrders: Array<{ workflowMode?: string; productName?: string | null; testName?: string }>,
): string => {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const order of testOrders) {
    if (order.workflowMode !== 'BILL_ONLY') continue;
    const label = order.productName || order.testName || '';
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels.join(', ');
};

const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const DiagnosticsFinalizedReports = () => {
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  const [dateRange, setDateRange] = useState<DateRangeState>(makeDateRange('today'));
  const [search, setSearch] = useState('');
  const [finalizedVisits, setFinalizedVisits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingVisitIds, setSendingVisitIds] = useState<Set<string>>(() => new Set());

  // Fetch finalized visits from API. `silent` skips the full-page spinner so
  // background revalidation swaps data in place.
  const fetchFinalizedVisits = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!token || !activeBranchId) return;
      try {
        if (!silent) setLoading(true);
        const params = new URLSearchParams({ status: 'COMPLETED' });
        const from = dateRangeFrom(dateRange);
        if (from) params.set('from', from);
        const response = await fetch(`${API_BASE}/visits/diagnostic?${params.toString()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId
          }
        });

        if (response.ok) {
          const data = await response.json();
          setFinalizedVisits(data);
        }
      } catch (error) {
        console.error('Failed to fetch finalized visits:', error);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token, activeBranchId, dateRange],
  );

  useEffect(() => {
    void fetchFinalizedVisits();
  }, [fetchFinalizedVisits]);

  // Revalidate when the staff return to a stale tab so newly finalized reports
  // show up without a manual refresh.
  useRevalidateOnFocus(() => void fetchFinalizedVisits({ silent: true }), {
    enabled: Boolean(token && activeBranchId),
    pollMs: 60_000,
  });

  // Build view data from API response.
  // Show a completed diagnostic visit when EITHER it has a finalized report
  // (the classic case) OR it has nothing to report — i.e. a pure bill-only
  // visit, or one where every reportable test was closed as "no report needed"
  // (films only). Those have no report but were still billed, so staff need to
  // find them here and (re)print the bill. Half-finished reportable visits
  // (report-inclusion orders but not finalized) stay hidden as before.
  const visitsWithDetails = useMemo(() => {
    return finalizedVisits
      .filter((visit) => visit.hasFinalizedReport || !visit.hasReportInclusionOrders)
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: visit.patient, // API response includes patient data
        testOrders: visit.testOrders || [], // API response includes test orders
      }));
  }, [finalizedVisits, activeBranchId]);

  const filteredVisits = useMemo(() => {
    const base = visitsWithDetails.filter(({ visit }) => {
      // Report rows sort by finalize time; bill-only / films-only rows have no
      // report, so fall back to when they were billed.
      const activityAt =
        visit.reportFinalizedAt ||
        visit.billedAt ||
        visit.updatedAt ||
        visit.createdAt;

      return matchesDateRange(dateRange, activityAt);
    });

    // Ranked, case-insensitive, phone-format-agnostic search (exact name first);
    // returns `base` unchanged when the search box is empty.
    return searchWorklist(base, search, ({ patient, visit }) => ({
      name: patient?.name,
      phone: patient?.identifiers?.find((id: any) => id.type === 'PHONE')?.value,
      billNumber: visit.billNumber,
    }));
  }, [visitsWithDetails, dateRange, search]);

  const paged = usePagedList(filteredVisits, `${search}|${dateRangeKey(dateRange)}`);

  // Optimistically patch a visit in local state so its green Printed/Sent
  // indicators update immediately, before the next refetch.
  const patchVisit = (visitId: string, patch: Record<string, any>) => {
    setFinalizedVisits((prev) =>
      prev.map((v) => (v.id === visitId ? { ...v, ...patch } : v)),
    );
  };

  // Record that the bill / report was printed from here (green print icon).
  // Best-effort: a failure here shouldn't block the actual print.
  const markPrinted = async (visitId: string, kind: 'bill' | 'report') => {
    patchVisit(
      visitId,
      kind === 'bill'
        ? { billPrintedAt: new Date().toISOString() }
        : { reportPrintedAt: new Date().toISOString() },
    );
    try {
      await fetch(`${API_BASE}/visits/diagnostic/${visitId}/mark-printed`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId,
        },
        body: JSON.stringify({ kind }),
      });
    } catch (error) {
      // Non-fatal — the print still happened; green just won't persist.
      console.error('Failed to record print:', error);
    }
  };

  const handleWhatsApp = async (visitId: string, isBillRow: boolean) => {
    if (sendingVisitIds.has(visitId)) return;
    setSendingVisitIds((prev) => {
      const next = new Set(prev);
      next.add(visitId);
      return next;
    });
    try {
      const endpoint = isBillRow ? 'send-bill' : 'send-report';
      const response = await fetch(`${API_BASE}/messages/${visitId}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId,
        },
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success(isBillRow ? 'Bill sent via WhatsApp' : 'Report sent via WhatsApp');
        patchVisit(
          visitId,
          isBillRow
            ? { billWhatsappSentAt: new Date().toISOString() }
            : { reportWhatsappSentAt: new Date().toISOString() },
        );
      } else {
        toast.error(data.error || 'Failed to send WhatsApp notification');
      }
    } catch (error) {
      toast.error('Failed to send WhatsApp notification');
    } finally {
      setSendingVisitIds((prev) => {
        const next = new Set(prev);
        next.delete(visitId);
        return next;
      });
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
        <PageHeader title="Finalized Reports" subtitle="View, print and share completed reports and bills" />

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

        {/* Finalized Reports List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              Reports ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              (() => {
                // Tell "no reports at all" apart from "filters hid them all".
                const hasData = visitsWithDetails.length > 0;
                return (
                  <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      {hasData ? (
                        <Search className="h-5 w-5" />
                      ) : (
                        <CheckCircle2 className="h-5 w-5" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {hasData
                          ? 'No reports match your filters'
                          : 'No finalized reports yet'}
                      </p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        {hasData
                          ? 'Try a different date range, or clear the search to see every finalized report.'
                          : 'Reports appear here once a diagnostic visit is completed and its report is finalized.'}
                      </p>
                    </div>
                    {hasData && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setDateFilter('all');
                          setSearch('');
                        }}
                      >
                        Clear filters
                      </Button>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="space-y-3">
                {paged.pageItems.map(({ visit, patient, testOrders }) => {
                  const p: any = patient || {};
                  const ageStr = compactAge(p);
                  const genderStr = p.gender || '';
                  const phoneVal = p.identifiers?.find((id: any) => id.type === 'PHONE')?.value || '';
                  const refName = formatRefDoctor((visit as any).referralDoctor?.name);
                  // A "bill row" is any completed visit with no finalized report:
                  // a pure bill-only visit, or one closed films-only. It gets a
                  // Print Bill action instead of View / Print Report.
                  const isBillRow = !visit.hasFinalizedReport;
                  const rowLabel = visit.hasBillOnlyOrders ? 'Bill only' : 'No report';
                  const testsLabel = formatTestList(testOrders) || formatBillOnlyList(testOrders);
                  const printedAt = isBillRow ? visit.billPrintedAt : visit.reportPrintedAt;
                  const sentAt = isBillRow ? visit.billWhatsappSentAt : visit.reportWhatsappSentAt;
                  const paidModes = formatPaymentModes(visit.paymentBreakdown, visit.paymentType);
                  const paidPaise = visit.paidAmountInPaise ?? 0;
                  const duePaise = visit.dueAmountInPaise ?? 0;
                  return (
                  <div
                    key={visit.id}
                    className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{formatPatientName(patient?.name || 'Unknown', (patient as any).title)}</span>
                        {(ageStr || genderStr) && (
                          <span className="text-muted-foreground">
                            {ageStr}
                            {ageStr && genderStr ? ' | ' : ''}
                            {genderStr}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span>
                          Bill #: <span className="font-mono">{visit.billNumber}</span>
                        </span>
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
                      {testsLabel && (
                        <div className="text-sm text-muted-foreground">
                          Tests: {testsLabel}
                        </div>
                      )}
                      {(paidPaise > 0 || duePaise > 0) && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                          {paidPaise > 0 && (
                            <span className="text-muted-foreground">
                              Paid: {formatCurrency(paidPaise)}
                              {paidModes ? ` · ${paidModes}` : ''}
                            </span>
                          )}
                          {duePaise > 0 && (
                            <span className="font-medium text-amber-700">
                              Due: {formatCurrency(duePaise)}
                            </span>
                          )}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <StatusBadge status={visit.status} />
                        {isBillRow && (
                          <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                            <Receipt className="h-3.5 w-3.5 shrink-0" />
                            {rowLabel}
                          </span>
                        )}
                        {printedAt && (
                          <span className="inline-flex items-center gap-1 text-sm text-success">
                            <Printer className="h-3.5 w-3.5 shrink-0" />
                            Printed{formatDateTime(printedAt) ? ` · ${formatDateTime(printedAt)}` : ''}
                          </span>
                        )}
                        {sentAt && (
                          <span className="inline-flex items-center gap-1 text-sm text-success">
                            <MessageCircle className="h-3.5 w-3.5 shrink-0" />
                            Sent{formatDateTime(sentAt) ? ` · ${formatDateTime(sentAt)}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className={cn(
                        'grid w-full gap-2 sm:flex sm:w-auto sm:items-center',
                        isBillRow ? 'grid-cols-2' : 'grid-cols-3',
                      )}
                    >
                      {isBillRow ? (
                        <Button
                          variant="outline"
                          size="icon"
                          className={cn(
                            'w-full sm:w-10',
                            printedAt && 'border-success text-success hover:text-success',
                          )}
                          onClick={() => {
                            markPrinted(visit.id, 'bill');
                            navigate(`/bill/print/DIAGNOSTICS/${visit.id}`);
                          }}
                          title={printedAt ? `Printed · ${formatDateTime(printedAt)}` : 'Print bill'}
                          aria-label="Print bill"
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            size="icon"
                            className="w-full sm:w-10"
                            onClick={() => navigate(`/diagnostics/preview/${visit.id}`)}
                            title="View Report"
                            aria-label="View report"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            className={cn(
                              'w-full sm:w-10',
                              printedAt && 'border-success text-success hover:text-success',
                            )}
                            onClick={() => {
                              markPrinted(visit.id, 'report');
                              openFinalizedReportWindow({
                                visitId: visit.id,
                                token,
                                branchId: activeBranchId,
                                autoPrint: true,
                              }).catch((error) => {
                                console.error('Print failed:', error);
                                toast.error('Report not available');
                              });
                            }}
                            title={printedAt ? `Printed · ${formatDateTime(printedAt)}` : 'Print'}
                            aria-label="Print report"
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      <Button
                        variant="outline"
                        size="icon"
                        className={cn(
                          'w-full sm:w-10',
                          sentAt && 'border-success text-success hover:text-success',
                        )}
                        onClick={() => handleWhatsApp(visit.id, isBillRow)}
                        disabled={sendingVisitIds.has(visit.id)}
                        title={
                          sentAt
                            ? `Sent · ${formatDateTime(sentAt)}`
                            : isBillRow
                              ? 'Send bill via WhatsApp'
                              : 'Send report via WhatsApp'
                        }
                        aria-label={isBillRow ? 'Send bill via WhatsApp' : 'Send report via WhatsApp'}
                      >
                        <MessageCircle className="h-4 w-4" />
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
      </div>
    </AppLayout>
  );
};

export default DiagnosticsFinalizedReports;

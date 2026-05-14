import { Fragment, useState, useEffect, lazy, Suspense } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { FlagBadge } from '@/components/ui/flag-badge';
import { toast } from 'sonner';
import { downloadFinalizedReportPdf, openFinalizedReportWindow } from '@/lib/reportAccess';
// Lazy-load the PDF preview so pdf.js (~470kB) only ships to users who
// actually open the preview pane, not on every page load.
const PdfPreview = lazy(() =>
  import('@/components/diagnostics/PdfPreview').then((m) => ({ default: m.PdfPreview }))
);
import { AlertTriangle, ArrowLeft, CheckCircle2, Lock, Printer, MessageCircle, Loader2, Eye, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface TestResult {
  id: string;
  testId: string;
  testName?: string;
  testCode?: string;
  value: number | null;
  flag: string | null;
  notes?: string;
}

interface ReportVersionSummary {
  id: string;
  versionNum: number;
  status: 'DRAFT' | 'FINALIZED' | string;
  finalizedAt?: string | null;
  testResults?: Array<{ id: string; testOrderId: string; testId: string }>;
}

interface Visit {
  id: string;
  billNumber: string;
  status: string;
  discountType?: 'FLAT_AMOUNT' | 'PERCENTAGE' | null;
  discountPercentage?: number | null;
  discountAmountInPaise?: number;
  paidAmountInPaise?: number;
  netAmountInPaise?: number;
  dueAmountInPaise?: number;
  hasReportableOrders?: boolean;
  hasBillOnlyOrders?: boolean;
  hasExternalUploadOrders?: boolean;
  hasReportInclusionOrders?: boolean;
  hasFinalizedReport?: boolean;
  nextAction?: 'ENTER_RESULTS' | 'NONE';
  createdAt: string;
  patient: {
    name: string;
    yearOfBirth?: number;
    dateOfBirth?: string;
    gender: string;
    identifiers?: Array<{ type: string; value: string }>;
  };
  testOrders: Array<{
    id: string;
    testId: string;
    testName: string;
    testCode: string;
    workflowMode?: 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD' | string;
    referenceRange: { min: number; max: number; unit: string };
  }>;
  referralDoctor?: { name: string } | null;
  report?: {
    id: string;
    currentVersion?: {
      id: string;
      status: string;
      testResults?: TestResult[];
    };
    versions?: ReportVersionSummary[];
  };
}

interface ReportSnapshotTest {
  testId: string;
  testName: string;
  value: number | null;
  textValue?: string | null;
  flag: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
  showMethod?: boolean;
  methodText: string | null;
  indentLevel: number;
  isBold?: boolean;
  isItalic?: boolean;
  subGroup: string | null;
  joinPrevious?: boolean;
  gridWidth?: number | null;
}

interface ReportSnapshotPanel {
  panelId: string;
  panelName: string;
  displayName: string;
  panelMethodText?: string | null;
  panelMethodItalic?: boolean;
  showSubgroups?: boolean;
  subgroupMethods?: Record<string, string> | null;
  tests: ReportSnapshotTest[];
}

interface ReportSnapshotDepartment {
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
  panels: ReportSnapshotPanel[];
}

interface ReportSnapshotData {
  departments: ReportSnapshotDepartment[];
}

function normalizeFlagForBadge(flag: string | null): 'HIGH' | 'LOW' | 'NORMAL' | null {
  if (flag === 'CRITICAL_HIGH') return 'HIGH';
  if (flag === 'CRITICAL_LOW') return 'LOW';
  if (flag === 'HIGH' || flag === 'LOW' || flag === 'NORMAL') return flag;
  return null;
}

function isAbnormalFlag(flag: string | null): boolean {
  return flag === 'HIGH' || flag === 'LOW' || flag === 'CRITICAL_HIGH' || flag === 'CRITICAL_LOW';
}

function formatResultValue(result: ReportSnapshotTest): string {
  if (result.textValue?.trim()) return result.textValue.trim();
  if (result.value === null || result.value === undefined) return '—';
  return String(result.value);
}

function formatReferenceRange(result: ReportSnapshotTest): string {
  if (result.referenceText?.trim()) return result.referenceText.trim();

  if (result.referenceMin !== null || result.referenceMax !== null) {
    const min = result.referenceMin ?? '';
    const max = result.referenceMax ?? '';
    const range = `${min}–${max}`.trim();
    return result.referenceUnit ? `${range} ${result.referenceUnit}`.trim() : range;
  }

  return '—';
}

function formatMoneyFromPaise(amountInPaise?: number | null): string {
  return `₹${((amountInPaise ?? 0) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const DiagnosticsReportPreview = () => {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Selection arriving from the entry page's partial-release dialog. When
  // present, the preview and the eventual /release-partial call only ship
  // these test orders; the rest stay in the next draft. Stored in state so
  // it persists across re-renders even after react-router clears the
  // navigation `state` reference.
  const partialSelectionFromNav =
    (location.state as { partialSelection?: string[] } | null)?.partialSelection;
  const [partialSelection] = useState<string[] | null>(
    partialSelectionFromNav && partialSelectionFromNav.length > 0
      ? partialSelectionFromNav
      : null,
  );
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  
  const [visit, setVisit] = useState<Visit | null>(null);
  const [reportSnapshot, setReportSnapshot] = useState<ReportSnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [finalizing, setFinalizing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showReleaseConfirm, setShowReleaseConfirm] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);  // blob URL for iframe
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendingWhatsApp, setSendingWhatsApp] = useState(false);
  const latestVersionId = (visit as any)?.report?.versions?.[0]?.id ?? visit?.report?.currentVersion?.id ?? null;

  // Fetch visit from API
  useEffect(() => {
    const fetchVisit = async () => {
      if (!visitId || !token || !activeBranchId) return;
      
      try {
        setLoading(true);
        const [visitResponse, snapshotResponse] = await Promise.all([
          fetch(`${API_BASE}/visits/diagnostic/${visitId}`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId
            }
          }),
          fetch(`${API_BASE}/visits/diagnostic/${visitId}/report-snapshot`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId
            }
          }),
        ]);

        if (visitResponse.ok) {
          const data = await visitResponse.json();
          // Allow preview for REPORTABLE OR EXTERNAL_UPLOAD visits — both produce a merged PDF.
          const hasInclusion =
            data.hasReportInclusionOrders ??
            (data.hasReportableOrders || data.hasExternalUploadOrders);
          if (hasInclusion === false) {
            toast.error('This visit is bill-only and does not have a report preview.');
            navigate('/diagnostics/pending');
            return;
          }
          setVisit(data);
        } else {
          setVisit(null);
          toast.error('Failed to load visit');
        }

        if (snapshotResponse.ok) {
          const snapshotData = await snapshotResponse.json();
          setReportSnapshot(snapshotData);
        } else {
          setReportSnapshot(null);
          console.error('Failed to load report snapshot');
        }
      } catch (error) {
        console.error('Failed to fetch visit:', error);
        setVisit(null);
        setReportSnapshot(null);
        toast.error('Failed to load visit');
      } finally {
        setLoading(false);
      }
    };

    fetchVisit();
  }, [visitId, token, activeBranchId]);

  useEffect(() => {
    setShowPreview(false);
    setShowConfirm(false);
    setPreviewUrl((currentUrl) => {
      if (currentUrl) {
        URL.revokeObjectURL(currentUrl);
      }
      return null;
    });
  }, [visitId, latestVersionId]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  if (loading) {
    return (
      <AppLayout context="diagnostics">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (!visit) {
    return (
      <AppLayout context="diagnostics">
        <div className="text-center py-12">
          <p className="text-muted-foreground">Visit not found</p>
          <Button className="mt-4" onClick={() => navigate('/diagnostics/pending')}>
            Back to Pending Results
          </Button>
        </div>
      </AppLayout>
    );
  }

  const { patient, referralDoctor } = visit;
  const currentYear = new Date().getFullYear();
  const patientAge = patient.yearOfBirth ? currentYear - patient.yearOfBirth : null;
  // Get test results from the latest version (versions are ordered by versionNum desc)
  const latestVersion = (visit.report as any)?.versions?.[0] ?? visit.report?.currentVersion;
  const testResults = latestVersion?.testResults || [];
  const results = testResults.map((result: any) => ({
    ...result,
    testName: result.testName || 'Unknown Test',
    testCode: result.testCode || '',
    referenceRange: result.referenceRange || { min: 0, max: 0, unit: '' }
  }));
  const snapshotTests = reportSnapshot?.departments.flatMap((department) =>
    department.panels.flatMap((panel) => panel.tests)
  ) || [];
  const hasAbnormalValues = snapshotTests.length > 0
    ? snapshotTests.some((result) => isAbnormalFlag(result.flag))
    : results.some((r) => r.flag === 'HIGH' || r.flag === 'LOW');
  const isFinalized = visit.hasFinalizedReport === true;
  const dueAmountInPaise = visit.dueAmountInPaise ?? 0;
  const hasDue = dueAmountInPaise > 0;

  // Partial-release support: count reportable test orders that have results
  // entered into the current DRAFT vs those still pending. Used to decide
  // whether to show the "Release Partial" button or the "Finalize" button —
  // they're mutually exclusive (XOR), so staff can never accidentally finalize
  // an incomplete report as if it were the final one.
  const reportableOrders = (visit.testOrders ?? []).filter(
    (order) => order.workflowMode === 'REPORTABLE' || order.workflowMode === undefined,
  );
  const versions = (visit.report as any)?.versions as ReportVersionSummary[] | undefined;
  const finalizedVersions = (versions ?? []).filter((v) => v.status === 'FINALIZED');
  const draftVersion = (versions ?? []).find((v) => v.status === 'DRAFT');
  const draftResultOrderIds = new Set(
    (draftVersion?.testResults ?? []).map((r) => r.testOrderId),
  );
  const readyReportableCount = reportableOrders.filter((o) =>
    draftResultOrderIds.has(o.id),
  ).length;
  const totalReportableCount = reportableOrders.length;
  const pendingReportableCount = Math.max(
    totalReportableCount - readyReportableCount,
    0,
  );
  // When the user arrived here from the per-test selector with an explicit
  // subset, this preview is unambiguously a partial release — even if every
  // order in the visit happens to be "ready" by row count. Force the modal
  // into the partial path so the right button and confirm copy appear.
  const userPickedSubset = partialSelection !== null;
  const canReleasePartial = userPickedSubset
    ? true
    : pendingReportableCount > 0 && readyReportableCount > 0;
  // External-upload-only visits have no reportable orders to "complete", but
  // they're still finalizable — the uploaded PDF is the report. The entry page
  // blocks save until uploads are attached, so by the time we reach the preview
  // the upload is already there.
  const isExternalUploadOnly =
    totalReportableCount === 0 && Boolean(visit.hasExternalUploadOrders);
  const canFinalizeAll = userPickedSubset
    ? false
    : (totalReportableCount > 0 && pendingReportableCount === 0) ||
      isExternalUploadOnly;
  // Test orders already sent to the patient in a prior finalized version —
  // shown with a "Sent in v{N}" hint so staff understand edits only affect v{N+1}.
  const sentTestOrderVersions = new Map<string, number>();
  for (const v of finalizedVersions) {
    for (const r of v.testResults ?? []) {
      if (!sentTestOrderVersions.has(r.testOrderId)) {
        sentTestOrderVersions.set(r.testOrderId, v.versionNum);
      }
    }
  }
  const lastFinalizedVersion = finalizedVersions[0];
  const nextVersionNum = (lastFinalizedVersion?.versionNum ?? 0) + 1;

  const handleFinalize = async () => {
    if (hasDue) {
      toast.error('Collect due before finalizing this report');
      return;
    }

    setFinalizing(true);
    try {
      const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/finalize`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        await response.json();
        toast.success('Report finalized successfully');
        
        setShowConfirm(false);
        
        // Refresh visit data
        const refreshResponse = await fetch(`${API_BASE}/visits/diagnostic/${visitId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          setVisit(refreshData);
        }
        
        // WhatsApp notification is sent automatically by the backend on finalize
        // Just inform the staff
        const phone = patient.identifiers?.find(id => id.type === 'PHONE')?.value;
        if (phone) {
          toast.success('Report finalized — WhatsApp report message will be sent automatically');
        }
      } else {
        const errorData = await response.json();
        toast.error(errorData.message || 'Failed to finalize report');
      }
    } catch (error) {
      console.error('Failed to finalize:', error);
      toast.error('Failed to finalize report');
    } finally {
      setFinalizing(false);
    }
  };

  const handleReleasePartial = async () => {
    if (hasDue) {
      toast.error('Collect due before releasing this partial report');
      return;
    }

    setReleasing(true);
    try {
      const response = await fetch(
        `${API_BASE}/visits/diagnostic/${visitId}/release-partial`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
            'Content-Type': 'application/json',
          },
          // When the user arrived here from the per-test selector dialog,
          // the body restricts the release to those orders. Omitting the
          // body falls back to the legacy "release all draft results"
          // behavior, so direct nav / older clients still work.
          body: partialSelection
            ? JSON.stringify({ testOrderIds: partialSelection })
            : undefined,
        },
      );

      if (response.ok) {
        await response.json();
        toast.success(
          `Partial report released — patient notified. ${pendingReportableCount} test${pendingReportableCount === 1 ? '' : 's'} still pending.`,
        );
        setShowReleaseConfirm(false);

        // Refresh visit data so the new DRAFT version (v+1) and prior finalized
        // version are visible.
        const refreshResponse = await fetch(
          `${API_BASE}/visits/diagnostic/${visitId}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId,
            },
          },
        );
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          setVisit(refreshData);
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        toast.error(errorData.message || 'Failed to release partial report');
      }
    } catch (error) {
      console.error('Failed to release partial:', error);
      toast.error('Failed to release partial report');
    } finally {
      setReleasing(false);
    }
  };

  const handlePrint = async () => {
    if (!visitId) {
      toast.error('Report not available. Please finalize the report first.');
      return;
    }

    try {
      // Opens a wrapper window with the merged PDF embedded and auto-triggers
      // the browser's print dialog — same one-click experience as before, but
      // now the PDF includes external uploads (the old HTML path didn't).
      await openFinalizedReportWindow({
        visitId,
        token,
        branchId: activeBranchId,
        autoPrint: true,
      });
    } catch (error: any) {
      console.error('Print failed:', error);
      toast.error(error?.message || 'Failed to open print view');
    }
  };

  const handleWhatsApp = async () => {
    if (sendingWhatsApp) return;
    setSendingWhatsApp(true);
    try {
      const response = await fetch(`${API_BASE}/messages/${visitId}/send-report`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId,
        },
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success('Completion notification sent via WhatsApp');
      } else {
        toast.error(data.error || 'Failed to send WhatsApp notification');
      }
    } catch (error) {
      toast.error('Failed to send WhatsApp notification');
    } finally {
      setSendingWhatsApp(false);
    }
  };

  const handlePreviewReport = async () => {
    setPreviewLoading(true);
    try {
      // Default response is the merged PDF (rendered values + appended uploads),
      // so the preview matches byte-for-byte what the patient receives.
      // When the user arrived here from the partial-release selector, scope
      // the preview to those test orders so the rendered PDF matches what
      // will actually ship.
      const previewQuery = partialSelection
        ? `?testOrderIds=${partialSelection.join(',')}`
        : '';
      const response = await fetch(
        `${API_BASE}/visits/diagnostic/${visitId}/preview-report${previewQuery}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        },
      );

      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        setPreviewUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
        setShowPreview(true);
      } else {
        const err = await response.json().catch(() => ({}));
        toast.error(err.message || 'Failed to generate report preview');
      }
    } catch (error) {
      console.error('Preview failed:', error);
      toast.error('Failed to generate report preview');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handlePreviewClose = () => {
    setShowPreview(false);
  };

  const handleFinalizeFromPreview = () => {
    if (hasDue) {
      toast.error('Collect due before finalizing this report');
      return;
    }
    setShowPreview(false);
    setShowConfirm(true);
  };

  const handleReleasePartialFromPreview = () => {
    if (hasDue) {
      toast.error('Collect due before releasing this partial report');
      return;
    }
    setShowPreview(false);
    setShowReleaseConfirm(true);
  };

  return (
    <AppLayout context="diagnostics">
      {/* Screen Content - Hidden when printing */}
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in no-print">
        {/* Header with Status */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => navigate(-1)}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                Report Preview
                {isFinalized && <Lock className="h-5 w-5 text-muted-foreground" />}
              </h1>
              <StatusBadge status={visit.status} />
            </div>
          </div>
          {isFinalized && (
            <div className="flex gap-2">
              <Button variant="outline" onClick={handlePrint}>
                <Printer className="mr-2 h-4 w-4" />
                Print
              </Button>
              <Button
                variant="outline"
                onClick={handleWhatsApp}
                disabled={sendingWhatsApp}
              >
                <MessageCircle className="mr-2 h-4 w-4" />
                {sendingWhatsApp ? 'Sending...' : 'WhatsApp'}
              </Button>
            </div>
          )}
        </div>

        {/* Prior partial-release banner — visible after a partial release while
            the visit stays open for the next batch of results. */}
        {!isFinalized && finalizedVersions.length > 0 && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-start gap-2">
            <Lock className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-700" />
            <div>
              <p className="font-medium">
                {finalizedVersions.length === 1
                  ? `Version ${lastFinalizedVersion.versionNum} sent to patient${
                      lastFinalizedVersion.finalizedAt
                        ? ` on ${new Date(lastFinalizedVersion.finalizedAt).toLocaleString()}`
                        : ''
                    }.`
                  : `${finalizedVersions.length} versions already sent to patient (latest: v${lastFinalizedVersion.versionNum}).`}
              </p>
              <p className="mt-0.5 text-blue-800">
                Editing remaining tests for version {nextVersionNum}. Earlier versions are locked — edits to already-sent tests will only appear in v{nextVersionNum}.
              </p>
            </div>
          </div>
        )}

        {/* Report Card */}
        <Card className={isFinalized ? 'border-success/30' : 'border-warning/30'}>
          <CardHeader className="border-b">
            <div className="flex justify-between">
              <div>
                <CardTitle>{patient.name}</CardTitle>
                <p className="text-muted-foreground">
                  {patientAge ? `${patientAge} yrs` : ''} | {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}
                </p>
                {referralDoctor && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Referred by: {referralDoctor.name}
                  </p>
                )}
              </div>
              <div className="text-right">
                <p className="font-mono font-bold text-lg">{visit.billNumber}</p>
                <p className="text-sm text-muted-foreground">
                  {new Date(visit.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {!reportSnapshot?.departments.length && !results.length && visit.hasExternalUploadOrders ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                This visit's report is an external PDF upload. Click <strong>Preview Report Before Finalization</strong> below to see the merged PDF with the Sobhana letterhead applied to your uploaded file(s).
              </div>
            ) : reportSnapshot?.departments.length ? (
              <div className="space-y-6">
                {reportSnapshot.departments.map((department) => (
                  <section key={department.departmentId} className="space-y-4">
                    <div className="border-b pb-2">
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                        {department.departmentHeaderText || department.departmentName}
                      </h3>
                    </div>

                    {department.panels.map((panel) => {
                      let previousGroup: string | null = null;

                      return (
                        <div key={panel.panelId} className="space-y-2">
                          <div>
                            <h4 className="font-semibold">
                              {panel.displayName || panel.panelName}
                            </h4>
                            {panel.panelMethodText && (
                              <p className={`text-xs text-muted-foreground${panel.panelMethodItalic ? ' italic' : ''}`}>
                                (Method : {panel.panelMethodText})
                              </p>
                            )}
                          </div>

                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Test</TableHead>
                                <TableHead className="text-right">Value</TableHead>
                                <TableHead className="text-right">Range</TableHead>
                                <TableHead className="text-right">Flag</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {(() => {
                                // Partition consecutive tests into runs (joinPrevious continues the previous run)
                                const runs: ReportSnapshotTest[][] = [];
                                for (const t of panel.tests) {
                                  if (!t.joinPrevious || runs.length === 0) runs.push([t]);
                                  else runs[runs.length - 1].push(t);
                                }
                                return runs.map((run, runIndex) => {
                                  const head = run[0];
                                  const subgroupName = head.subGroup?.trim() || null;
                                  const showGroupRow = Boolean(
                                    panel.showSubgroups && subgroupName && subgroupName !== previousGroup
                                  );
                                  previousGroup = subgroupName;

                                  if (run.length > 1) {
                                    return (
                                      <Fragment key={`${panel.panelId}-grid-${runIndex}`}>
                                        {showGroupRow && (
                                          <TableRow>
                                            <TableCell colSpan={4} className="bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                              {subgroupName}
                                              {subgroupName && panel.subgroupMethods?.[subgroupName] ? (
                                                <span className="ml-2 normal-case tracking-normal italic">
                                                  Method : {panel.subgroupMethods[subgroupName]}
                                                </span>
                                              ) : null}
                                            </TableCell>
                                          </TableRow>
                                        )}
                                        <TableRow>
                                          <TableCell colSpan={4} className="py-2">
                                            <div className="flex items-baseline gap-6">
                                              {run.map((cell, cellIdx) => {
                                                const flexStyle = cell.gridWidth
                                                  ? { flex: `${cell.gridWidth} 0 0` }
                                                  : { flex: '1 0 0' };
                                                return (
                                                  <div
                                                    key={`${cell.testId}-${cellIdx}`}
                                                    className="flex items-baseline gap-2 min-w-0"
                                                    style={flexStyle}
                                                  >
                                                    <span className={`truncate ${cell.isBold ? 'font-semibold' : ''}`}>
                                                      {cell.testName}
                                                    </span>
                                                    <span className="text-muted-foreground">:</span>
                                                    <span className="font-mono">
                                                      {formatResultValue(cell)}
                                                    </span>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </TableCell>
                                        </TableRow>
                                      </Fragment>
                                    );
                                  }

                                  const result = head;
                                  return (
                                    <Fragment key={`${panel.panelId}-${result.testId}-${runIndex}`}>
                                      {showGroupRow && (
                                        <TableRow>
                                          <TableCell colSpan={4} className="bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            {subgroupName}
                                            {subgroupName && panel.subgroupMethods?.[subgroupName] ? (
                                              <span className="ml-2 normal-case tracking-normal italic">
                                                Method : {panel.subgroupMethods[subgroupName]}
                                              </span>
                                            ) : null}
                                          </TableCell>
                                        </TableRow>
                                      )}
                                      <TableRow>
                                        <TableCell className="align-top">
                                          <div
                                            className={`leading-tight${result.isBold ? ' font-semibold' : ''}${result.isItalic ? ' italic' : ''}`}
                                            style={{ paddingLeft: `${(result.indentLevel || 0) * 12}px` }}
                                          >
                                            {result.testName}
                                          </div>
                                          {result.showMethod && result.methodText && (
                                            <div className={`mt-1 text-xs text-muted-foreground${result.isItalic ? ' italic' : ''}`}>
                                              (Method : {result.methodText})
                                            </div>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-right font-mono">
                                          {formatResultValue(result)}
                                        </TableCell>
                                        <TableCell className="text-right text-muted-foreground">
                                          {formatReferenceRange(result)}
                                        </TableCell>
                                        <TableCell className="text-right">
                                          <FlagBadge flag={normalizeFlagForBadge(result.flag)} />
                                        </TableCell>
                                      </TableRow>
                                    </Fragment>
                                  );
                                });
                              })()}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Test</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Range</TableHead>
                    <TableHead className="text-right">Flag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result) => (
                    <TableRow key={result.id}>
                      <TableCell className="font-medium">{result.testName}</TableCell>
                      <TableCell className="text-right font-mono">
                        {result.value ?? '—'}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {result.referenceRange.min > 0 || result.referenceRange.max > 0
                          ? `${result.referenceRange.min}–${result.referenceRange.max} ${result.referenceRange.unit}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <FlagBadge flag={result.flag as 'HIGH' | 'LOW' | 'NORMAL' | null} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* Abnormal Values Warning */}
            {hasAbnormalValues && !isFinalized && (
              <div className="mt-4 p-3 rounded-lg bg-warning/10 border border-warning/30 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" />
                <span className="text-sm font-medium">Abnormal values detected</span>
              </div>
            )}
            {hasDue && !isFinalized && (
              <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 flex items-center gap-2 text-amber-800">
                <AlertTriangle className="h-5 w-5" />
                <span className="text-sm font-medium">
                  Bill due {formatMoneyFromPaise(dueAmountInPaise)}. Collect due from Pending Results before finalizing.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions — Finalize / Release lives only inside the preview modal so
            staff are forced to review the rendered PDF before sending. The main
            page only offers "Preview" (and Back to Edit). */}
        {!isFinalized && (
          <div className="flex gap-3">
            <Button
              variant="outline"
              onClick={() => navigate(`/diagnostics/results/${visit.id}`)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Edit
            </Button>
            <Button
              variant="secondary"
              className="flex-1"
              onClick={handlePreviewReport}
              disabled={previewLoading}
            >
              {previewLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              {previewLoading ? 'Generating...' : 'Preview Report Before Finalization'}
            </Button>
          </div>
        )}

        {/* Finalized Notice */}
        {isFinalized && (
          <Card className="bg-success/5 border-success/30 no-print">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-8 w-8 text-success" />
                <div className="flex-1">
                  <p className="font-semibold">Report Finalized</p>
                  <p className="text-sm text-muted-foreground">
                    This report is now locked and cannot be edited.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!visitId) {
                        toast.error('Report not available');
                        return;
                      }

                      downloadFinalizedReportPdf({
                        visitId,
                        token,
                        branchId: activeBranchId,
                      }).catch((error) => {
                        console.error('Download failed:', error);
                        toast.error('Failed to download report');
                      });
                    }}
                    className="text-sm text-primary hover:underline mt-1 inline-block"
                  >
                    Download Report →
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Full-Screen Report Preview Modal */}
      {showPreview && previewUrl && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
          {/* Modal Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b bg-background">
            <div className="flex items-center gap-3">
              <Eye className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold text-lg">Report Preview</h2>
                <p className="text-xs text-muted-foreground">This is how the final PDF will look to the patient. No data has been saved.</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canReleasePartial ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleReleasePartialFromPreview}
                  disabled={hasDue}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {hasDue
                    ? 'Collect Due Before Releasing'
                    : `Looks Good — Release ${readyReportableCount} of ${totalReportableCount}`}
                </Button>
              ) : canFinalizeAll ? (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleFinalizeFromPreview}
                  disabled={hasDue}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {hasDue ? 'Collect Due Before Finalizing' : 'Looks Good — Finalize'}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon"
                onClick={handlePreviewClose}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>
          {/* Cross-browser PDF preview — renders pages via pdf.js so the
              browser's native PDF chrome (Chrome's dark toolbar, Safari's
              bar, Firefox's sidebar) never appears. Looks identical
              everywhere. Print/download buttons live on the page header. */}
          <div className="flex-1 overflow-hidden">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading viewer…
                </div>
              }
            >
              <PdfPreview src={previewUrl} />
            </Suspense>
          </div>
        </div>
      )}

      {/* Partial Release Confirmation */}
      <AlertDialog open={showReleaseConfirm} onOpenChange={setShowReleaseConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Release Partial Report?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Send the {readyReportableCount} test{readyReportableCount === 1 ? '' : 's'} that {readyReportableCount === 1 ? 'is' : 'are'} ready now. The patient will receive a partial report immediately and a separate WhatsApp message when the remaining {pendingReportableCount} test{pendingReportableCount === 1 ? '' : 's'} {pendingReportableCount === 1 ? 'is' : 'are'} completed.
                </p>
                <p className="text-muted-foreground">
                  This finalizes version {(draftVersion?.versionNum ?? nextVersionNum)}. Edits to these tests after release will only appear in the next version.
                </p>
                {hasAbnormalValues && (
                  <p className="font-medium text-warning">
                    ⚠ This batch contains abnormal values.
                  </p>
                )}
                {hasDue && (
                  <p className="font-medium text-amber-700">
                    Bill due {formatMoneyFromPaise(dueAmountInPaise)} must be collected before release.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReleasePartial}
              disabled={releasing || hasDue}
            >
              {releasing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-2 h-4 w-4" />
              )}
              {releasing ? 'Releasing...' : 'Release Partial Report'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Finalize Confirmation */}
      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Finalize Report?</AlertDialogTitle>
            <AlertDialogDescription>
              This action is irreversible. Once finalized, the report cannot be edited.
              {hasAbnormalValues && (
                <p className="mt-2 font-medium text-warning">
                  ⚠ This report contains abnormal values.
                </p>
              )}
              {hasDue && (
                <p className="mt-2 font-medium text-amber-700">
                  Bill due {formatMoneyFromPaise(dueAmountInPaise)} must be collected before finalization.
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleFinalize} disabled={finalizing || hasDue}>
              {finalizing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Lock className="mr-2 h-4 w-4" />
              )}
              {finalizing ? 'Finalizing...' : 'Finalize Report'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default DiagnosticsReportPreview;

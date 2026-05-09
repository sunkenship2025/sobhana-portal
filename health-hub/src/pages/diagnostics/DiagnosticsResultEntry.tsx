import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReportFramedNarrativeEditor } from '@/components/diagnostics/ReportFramedNarrativeEditor';
import { RichTextToolbar } from '@/components/diagnostics/RichTextToolbar';
import {
  DEFAULT_TOOLBAR_STATE,
  type RichTextSurfaceHandle,
  type ToolbarState,
} from '@/components/diagnostics/RichTextSurface';
import {
  PartialReleaseSelectorDialog,
  type PartialReleaseGroup,
} from '@/components/diagnostics/PartialReleaseSelectorDialog';
import { TestValueCombobox } from '@/components/diagnostics/TestValueCombobox';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { FlagBadge } from '@/components/ui/flag-badge';
import { toast } from 'sonner';
import { AlertTriangle, Save, Loader2, ChevronDown, ChevronUp, Lock } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import {
  safeEvaluateFormula,
  topologicalSortDerivedTests,
  buildReverseDependencyMap,
  DerivedTestInfo,
} from '@/lib/formulaUtils';
import {
  hasMeaningfulRichText,
  normalizeRichTextForStorage,
  plainTextToRichText,
} from '@/lib/richText';

interface ReferenceRange {
  min: number;
  max: number;
  unit: string;
  text?: string;
}

type TestInputType = 'NUMERIC' | 'FREE_TEXT' | 'TEXT_WITH_PRESETS' | 'SELECT_ONLY';

interface TestInputConfig {
  inputType: TestInputType;
  defaultValue: string | null;
  valueOptions: string[];
}

const DEFAULT_INPUT_CONFIG: TestInputConfig = {
  inputType: 'NUMERIC',
  defaultValue: null,
  valueOptions: [],
};

interface ChildTest {
  id: string;
  name: string;
  code: string;
  displayOrder: number;
  isDerived?: boolean;
  formulaExpression?: string | null;
  dependsOnCodes?: string[] | null;
  referenceRange: ReferenceRange;
  inputConfig?: TestInputConfig;
}

interface TestOrder {
  id: string;
  testId: string;
  testDefinitionId?: string;
  workflowMode?: 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD';
  testName: string;
  testCode: string;
  price: number;
  isPanel: boolean;
  isDerived?: boolean;
  formulaExpression?: string | null;
  dependsOnCodes?: string[] | null;
  referenceRange: ReferenceRange;
  inputConfig?: TestInputConfig;
  childTests: ChildTest[];
  department?: {
    id: string;
    name: string;
  } | null;
  panel?: {
    id: string;
    name: string;
    displayName: string;
    layoutType: string;
    panelMethodText?: string | null;
    panelMethodItalic?: boolean;
    narrativeTemplateHtml?: string | null;
  } | null;
}

interface ExternalUpload {
  id: string;
  testOrderId: string;
  visitId: string;
  originalFilename: string;
  fileSizeBytes: number;
  pageCount: number | null;
  displayOrder: number;
  uploadedAt: string;
}

interface Visit {
  id: string;
  billNumber: string;
  status: string;
  hasReportableOrders?: boolean;
  hasExternalUploadOrders?: boolean;
  hasReportInclusionOrders?: boolean;
  nextAction?: 'ENTER_RESULTS' | 'NONE';
  patient: {
    name: string;
    yearOfBirth?: number;
    gender: string;
  };
  testOrders: TestOrder[];
  report?: {
    id: string;
    versions?: Array<{
      id: string;
      versionNum?: number;
      status: string;
      finalizedAt?: string | null;
      testResults?: Array<{
        testId: string;
        testOrderId?: string;
        value: number;
        textValue?: string | null;
        notes?: string | null;
        manualOverride?: boolean;
        flag: string;
      }>;
    }>;
  };
}

const DERIVED_MANUAL_OVERRIDE_NOTE = '__DERIVED_MANUAL_OVERRIDE__';
function isRichTextPanelLayout(layoutType?: string | null): boolean {
  return layoutType === 'TEXT_ONLY' || layoutType === 'IMAGING_NARRATIVE';
}

function normalizeNarrativeContent(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return '';
  }

  return trimmed.includes('<')
    ? normalizeRichTextForStorage(trimmed)
    : plainTextToRichText(trimmed);
}

function hasResultValue(value: string | undefined, layoutType?: string): boolean {
  if (!value) {
    return false;
  }

  if (isRichTextPanelLayout(layoutType)) {
    return hasMeaningfulRichText(value);
  }

  return value.trim().length > 0;
}

function isManualDerivedOverride(
  testResult?: {
    manualOverride?: boolean;
    notes?: string | null;
  } | null
): boolean {
  return Boolean(
    testResult?.manualOverride ||
      testResult?.notes?.trim() === DERIVED_MANUAL_OVERRIDE_NOTE
  );
}

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return 'just now';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  return 'a while ago';
}

function renderAutoSaveStatus(
  status: 'idle' | 'unsaved' | 'saving' | 'saved' | 'error',
  lastSavedAt: number | null,
): JSX.Element | null {
  switch (status) {
    case 'saving':
      return <p className="mt-4 text-right text-sm text-muted-foreground">Saving…</p>;
    case 'saved':
      return (
        <p className="mt-4 text-right text-sm text-muted-foreground">
          Saved · {formatRelativeTime(lastSavedAt)}
        </p>
      );
    case 'unsaved':
      return <p className="mt-4 text-right text-sm text-muted-foreground">Unsaved changes</p>;
    case 'error':
      return <p className="mt-4 text-right text-sm text-amber-700">Save failed — will retry</p>;
    default:
      return null;
  }
}

function areResultsEqual(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key) => left[key] === right[key]);
}

const DiagnosticsResultEntry = () => {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();

  const [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const [derivedManualOverrides, setDerivedManualOverrides] = useState<Record<string, boolean>>({});
  const [showWarning, setShowWarning] = useState(false);
  const [extremeValues, setExtremeValues] = useState<string[]>([]);
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});
  // Uploads keyed by testOrderId. Populated from /api/external-uploads/by-visit on mount
  // and mutated locally as the user uploads / deletes files.
  const [uploadsByOrder, setUploadsByOrder] = useState<Record<string, ExternalUpload[]>>({});
  const [uploadingOrderId, setUploadingOrderId] = useState<string | null>(null);

  // Auto-save: debounced background persistence so techs never have to think
  // about saving. Status drives the inline indicator above the explicit button.
  type AutoSaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<'saved' | 'empty' | 'failed'> | null>(null);
  // Skips the very first results-changed render after fetchVisit populates state.
  const autoSavePrimedRef = useRef(false);

  // Active narrative editor — tracks which framed editor on the page currently
  // owns the cursor, so the single sticky toolbar can dispatch its commands to
  // that editor's contentEditable surface.
  const activeSurfaceRef = useRef<RichTextSurfaceHandle | null>(null);
  const activeSurfaceTestIdRef = useRef<string | null>(null);
  const [activeSurfaceTestId, setActiveSurfaceTestId] = useState<string | null>(null);
  const [sharedToolbarState, setSharedToolbarState] = useState<ToolbarState>(DEFAULT_TOOLBAR_STATE);

  // Partial-release selector dialog state. Opens when staff clicks
  // "Continue with Partial Report" and there's a real choice to make
  // (more than one ready test, or template-only narratives need to be
  // explicitly opted into).
  const [partialDialogOpen, setPartialDialogOpen] = useState(false);

  const textLayoutByTestId = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      const layoutType = order.panel?.layoutType;
      if (layoutType === 'TEXT_ONLY' || layoutType === 'IMAGING_NARRATIVE') {
        if (order.isPanel && order.childTests.length > 0) {
          order.childTests.forEach((child) => map.set(child.id, layoutType));
        } else {
          map.set(order.testId, layoutType);
        }
      }
    });

    return map;
  }, [visit]);

  // Map of testId → normalized narrativeTemplateHtml for narrative tests.
  // Used to detect when a narrative test still has only the unedited template
  // (so partial release pre-unchecks it instead of silently shipping the
  // boilerplate as if it were the actual report).
  const narrativeTemplateByTestId = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      const layoutType = order.panel?.layoutType;
      if (!isRichTextPanelLayout(layoutType)) return;
      const tpl = normalizeNarrativeContent(order.panel?.narrativeTemplateHtml);
      if (!hasMeaningfulRichText(tpl)) return;
      const targets =
        order.isPanel && order.childTests.length > 0
          ? order.childTests.map((c) => c.id)
          : [order.testId];
      targets.forEach((id) => map.set(id, tpl));
    });

    return map;
  }, [visit]);

  // Build derived test metadata from both standalone and panel tests
  const derivedTestsInfo = useMemo((): DerivedTestInfo[] => {
    if (!visit) return [];

    const derived: DerivedTestInfo[] = [];

    visit.testOrders.forEach((order) => {
      if (order.isDerived && order.formulaExpression && order.dependsOnCodes) {
        derived.push({
          testId: order.testId,
          code: order.testCode,
          formulaExpression: order.formulaExpression,
          dependsOnCodes: order.dependsOnCodes,
        });
      }

      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          if (child.isDerived && child.formulaExpression && child.dependsOnCodes) {
            derived.push({
              testId: child.id,
              code: child.code,
              formulaExpression: child.formulaExpression,
              dependsOnCodes: child.dependsOnCodes,
            });
          }
        });
      }
    });

    return derived;
  }, [visit]);

  // Build testId-to-code map
  const testIdToCodeMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      map.set(order.testId, order.testCode);
      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          map.set(child.id, child.code);
        });
      }
    });

    return map;
  }, [visit]);

  // Map testId → entry-time input config (presets, default value, input type)
  const testInputConfigByTestId = useMemo(() => {
    const map = new Map<string, TestInputConfig>();
    if (!visit) return map;
    visit.testOrders.forEach((order) => {
      if (order.inputConfig) map.set(order.testId, order.inputConfig);
      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          if (child.inputConfig) map.set(child.id, child.inputConfig);
        });
      }
    });
    return map;
  }, [visit]);

  // Build reverse dependency map
  const reverseDependencyMap = useMemo(() => {
    return buildReverseDependencyMap(derivedTestsInfo);
  }, [derivedTestsInfo]);

  // Topologically sorted derived tests
  const sortedDerivedTests = useMemo(() => {
    return topologicalSortDerivedTests(derivedTestsInfo);
  }, [derivedTestsInfo]);

  const recalculateDerivedResults = useCallback(
    (
      currentResults: Record<string, string>,
      changedCode?: string,
      manualOverrides: Record<string, boolean> = derivedManualOverrides
    ): Record<string, string> => {
      if (sortedDerivedTests.length === 0) {
        return currentResults;
      }

      const updated = { ...currentResults };
      const valuesByCode = new Map<string, number>();

      for (const [id, valueStr] of Object.entries(updated)) {
        const code = testIdToCodeMap.get(id);
        const numericValue = parseFloat(valueStr);
        if (code && !isNaN(numericValue)) {
          valuesByCode.set(code, numericValue);
        }
      }

      const testsToRecalculate = new Set<string>();
      if (changedCode) {
        const directDependents = reverseDependencyMap.get(changedCode) || [];
        directDependents.forEach((test) => testsToRecalculate.add(test.code));

        if (testsToRecalculate.size === 0) {
          return updated;
        }
      }

      for (const derivedTest of sortedDerivedTests) {
        const needsRecalc =
          !changedCode ||
          derivedTest.dependsOnCodes.some(
            (depCode) =>
              testsToRecalculate.has(depCode) || depCode === changedCode
          );

        if (!needsRecalc) {
          continue;
        }

        if (manualOverrides[derivedTest.testId]) {
          testsToRecalculate.add(derivedTest.code);
          continue;
        }

        testsToRecalculate.add(derivedTest.code);

        const calculatedValue = safeEvaluateFormula(
          derivedTest.formulaExpression,
          valuesByCode
        );

        if (calculatedValue !== null) {
          updated[derivedTest.testId] = calculatedValue.toString();
          valuesByCode.set(derivedTest.code, calculatedValue);
        } else {
          delete updated[derivedTest.testId];
          valuesByCode.delete(derivedTest.code);
        }
      }

      return updated;
    },
    [derivedManualOverrides, reverseDependencyMap, sortedDerivedTests, testIdToCodeMap]
  );

  // Fetch visit from API
  useEffect(() => {
    const fetchVisit = async () => {
      if (!visitId || !token || !activeBranchId) return;

      try {
        setLoading(true);
        const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId
          }
        });

        if (response.ok) {
          const data = await response.json();
          // The visit needs entry only if it has REPORTABLE values OR EXTERNAL_UPLOAD attachments.
          // hasReportInclusionOrders is the canonical flag (added when EXTERNAL_UPLOAD shipped);
          // fall back to the older fields for backward compatibility.
          const hasInclusion =
            data.hasReportInclusionOrders ??
            (data.hasReportableOrders || data.hasExternalUploadOrders);
          if (hasInclusion === false) {
            toast.error('This visit is bill-only and does not use result entry.');
            navigate('/diagnostics/pending');
            return;
          }

          data.testOrders = data.testOrders.filter((order: TestOrder) => order.workflowMode !== 'BILL_ONLY');
          const panelExpansion: Record<string, boolean> = {};
          const fetchedTextLayoutByTestId = new Map<string, string>();
          const fetchedNarrativeTemplateByTestId = new Map<string, string>();

          data.testOrders.forEach((order: TestOrder) => {
            // Expand legacy panels by order.id
            if (order.isPanel) {
              panelExpansion[order.id] = true;
            }
            // Expand new panel groups by panel.id (default expanded)
            if (order.panel?.id) {
              panelExpansion[order.panel.id] = true;
            }

            const layoutType = order.panel?.layoutType;
            if (layoutType === 'TEXT_ONLY' || layoutType === 'IMAGING_NARRATIVE') {
              const targetIds =
                order.isPanel && order.childTests.length > 0
                  ? order.childTests.map((child) => child.id)
                  : [order.testId];

              targetIds.forEach((targetId) => {
                fetchedTextLayoutByTestId.set(targetId, layoutType);
                if (isRichTextPanelLayout(layoutType)) {
                  fetchedNarrativeTemplateByTestId.set(
                    targetId,
                    normalizeNarrativeContent(order.panel?.narrativeTemplateHtml)
                  );
                }
              });
            }
          });

          // Initialize results from existing test results if any
          const initialResults: Record<string, string> = {};
          const initialManualOverrides: Record<string, boolean> = {};

          if (data.report?.versions?.[0]?.testResults) {
            const latestVersion = data.report.versions[0];
            latestVersion.testResults.forEach((r: any) => {
              const layoutType = fetchedTextLayoutByTestId.get(r.testId);
              if (r.textValue) {
                initialResults[r.testId] =
                  isRichTextPanelLayout(layoutType)
                    ? normalizeNarrativeContent(r.textValue)
                    : r.textValue;
              } else if (r.value !== null) {
                initialResults[r.testId] = r.value.toString();
              }

              if (isManualDerivedOverride(r)) {
                initialManualOverrides[r.testId] = true;
              }
            });
          }

          fetchedNarrativeTemplateByTestId.forEach((templateHtml, testId) => {
            if (!initialResults[testId] && hasMeaningfulRichText(templateHtml)) {
              initialResults[testId] = templateHtml;
            }
          });

          // Pre-fill input default values for tests that have one configured AND
          // have no saved/in-progress value yet. Defaults never overwrite saved data.
          data.testOrders.forEach((order: TestOrder) => {
            const apply = (testId: string, cfg?: TestInputConfig) => {
              if (!cfg?.defaultValue) return;
              if (initialResults[testId]) return;
              initialResults[testId] = cfg.defaultValue;
            };
            apply(order.testId, order.inputConfig);
            if (order.isPanel && order.childTests) {
              order.childTests.forEach((child) => apply(child.id, child.inputConfig));
            }
          });

          setResults(recalculateDerivedResults(initialResults, undefined, initialManualOverrides));
          setDerivedManualOverrides(initialManualOverrides);

          setExpandedPanels(panelExpansion);
          setVisit(data);
        } else {
          toast.error('Failed to load visit');
        }
      } catch (error) {
        console.error('Failed to fetch visit:', error);
        toast.error('Failed to load visit');
      } finally {
        setLoading(false);
      }
    };

    fetchVisit();
  }, [visitId, token, activeBranchId]);

  // Fetch external uploads for the visit (renders the per-order upload zones).
  useEffect(() => {
    if (!visitId || !token || !activeBranchId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/external-uploads/by-visit/${visitId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        });
        if (!response.ok) return;
        const list: ExternalUpload[] = await response.json();
        if (cancelled) return;
        const grouped: Record<string, ExternalUpload[]> = {};
        for (const upload of list) {
          if (!grouped[upload.testOrderId]) grouped[upload.testOrderId] = [];
          grouped[upload.testOrderId].push(upload);
        }
        setUploadsByOrder(grouped);
      } catch (error) {
        console.error('Failed to fetch external uploads:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [visitId, token, activeBranchId]);

  const uploadFileForOrder = useCallback(async (testOrderId: string, file: File) => {
    if (!token || !activeBranchId) return;
    if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are supported');
      return;
    }
    setUploadingOrderId(testOrderId);
    try {
      const formData = new FormData();
      formData.append('pdf', file);
      formData.append('testOrderId', testOrderId);
      const response = await fetch(`${API_BASE}/external-uploads`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Upload failed');
      }
      const created: ExternalUpload = await response.json();
      setUploadsByOrder((prev) => ({
        ...prev,
        [testOrderId]: [...(prev[testOrderId] || []), created],
      }));
      toast.success(`Uploaded ${created.originalFilename}`);
    } catch (error: any) {
      toast.error(error.message || 'Upload failed');
    } finally {
      setUploadingOrderId(null);
    }
  }, [token, activeBranchId]);

  const deleteUpload = useCallback(async (uploadId: string, testOrderId: string) => {
    if (!token || !activeBranchId) return;
    try {
      const response = await fetch(`${API_BASE}/external-uploads/${uploadId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Delete failed');
      }
      setUploadsByOrder((prev) => ({
        ...prev,
        [testOrderId]: (prev[testOrderId] || []).filter((u) => u.id !== uploadId),
      }));
      toast.success('Upload removed');
    } catch (error: any) {
      toast.error(error.message || 'Delete failed');
    }
  }, [token, activeBranchId]);

  // Build the same {testId, value, textValue, flag, ...} payload that the
  // explicit save uses, but as a pure function so both the auto-save effect
  // and saveResults() share one source of truth. Returns 'empty' when there
  // is nothing meaningful to send (e.g. external-upload-only visit before the
  // PDF is attached) so callers can decide whether that's a valid state.
  const persistDraft = useCallback(async (): Promise<'saved' | 'empty' | 'failed'> => {
    if (!visit || !visitId) return 'empty';

    type TestForSave = { testId: string; min: number; max: number; isDerived: boolean };
    const allTests: TestForSave[] = [];
    visit.testOrders.forEach((order) => {
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return;
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        order.childTests.forEach((child) => {
          allTests.push({
            testId: child.id,
            min: child.referenceRange.min,
            max: child.referenceRange.max,
            isDerived: !!child.isDerived,
          });
        });
      } else {
        allTests.push({
          testId: order.testId,
          min: order.referenceRange.min,
          max: order.referenceRange.max,
          isDerived: !!order.isDerived,
        });
      }
    });

    const flagFor = (value: number, min: number, max: number): 'NORMAL' | 'HIGH' | 'LOW' | null => {
      if (min === 0 && max === 0) return null;
      if (min > 0 && value < min) return 'LOW';
      if (max > 0 && value > max) return 'HIGH';
      return 'NORMAL';
    };

    const resultsArray = allTests
      .filter((test) => hasResultValue(results[test.testId], textLayoutByTestId.get(test.testId)))
      .map((test) => {
        const layoutType = textLayoutByTestId.get(test.testId);
        const rawValue = results[test.testId];
        const valueStr = isRichTextPanelLayout(layoutType)
          ? normalizeNarrativeContent(rawValue)
          : rawValue;
        const forceTextValue = textLayoutByTestId.has(test.testId);
        const parsedValue = parseFloat(valueStr);
        const isNumeric = !forceTextValue && !isNaN(parsedValue) && valueStr.trim() !== '';
        const flag = isNumeric ? flagFor(parsedValue, test.min, test.max) : null;
        return {
          testId: test.testId,
          value: isNumeric ? parsedValue : null,
          textValue: valueStr,
          flag: isNumeric ? (flag || 'NORMAL') : null,
          notes: null,
          manualOverride: test.isDerived ? !!derivedManualOverrides[test.testId] : false,
        };
      });

    if (resultsArray.length === 0) {
      return 'empty';
    }

    try {
      const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/results`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ results: resultsArray }),
      });
      return response.ok ? 'saved' : 'failed';
    } catch (error) {
      console.error('persistDraft failed:', error);
      return 'failed';
    }
  }, [visit, visitId, results, derivedManualOverrides, textLayoutByTestId, token, activeBranchId]);

  // Drive the inline status indicator. Coordinates in-flight saves so we don't
  // race two POSTs.
  const runAutoSave = useCallback(async () => {
    if (inFlightSaveRef.current) return;
    setAutoSaveStatus('saving');
    const promise = persistDraft();
    inFlightSaveRef.current = promise;
    try {
      const result = await promise;
      if (result === 'saved') {
        dirtyRef.current = false;
        setLastSavedAt(Date.now());
        setAutoSaveStatus('saved');
      } else if (result === 'empty') {
        dirtyRef.current = false;
        setAutoSaveStatus('idle');
      } else {
        setAutoSaveStatus('error');
      }
    } finally {
      inFlightSaveRef.current = null;
    }
  }, [persistDraft]);

  // Schedule a debounced auto-save whenever the user edits results. The very
  // first non-loading render is the initial population from fetchVisit, not a
  // user edit — that one is suppressed via autoSavePrimedRef.
  useEffect(() => {
    if (loading || !visit) return;
    if (!autoSavePrimedRef.current) {
      autoSavePrimedRef.current = true;
      return;
    }

    // Mirror the disabled-button conditions: nothing to save yet, or the form
    // is in an invalid state pending external uploads.
    const hasAnyManualValueShape = visit.testOrders.some((order) => {
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return false;
      if (!order.isPanel) return true;
      return order.childTests.length > 0;
    });
    const missingExternalUpload = visit.testOrders.some(
      (order) =>
        order.workflowMode === 'EXTERNAL_UPLOAD' &&
        (!uploadsByOrder[order.id] || uploadsByOrder[order.id].length === 0),
    );
    if (!hasAnyManualValueShape || missingExternalUpload) return;

    dirtyRef.current = true;
    setAutoSaveStatus('unsaved');

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void runAutoSave();
    }, 1500);
  }, [results, derivedManualOverrides, loading, visit, uploadsByOrder, runAutoSave]);

  // Clear any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, []);

  // Field-level blur: if the user tabs/clicks out of a dirty field, save now
  // rather than waiting out the 1.5s debounce. React's onBlur bubbles, so a
  // single listener on the form container catches every input/textarea/
  // contenteditable inside.
  const handleFormBlur = useCallback(() => {
    if (!dirtyRef.current) return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    void runAutoSave();
  }, [runAutoSave]);

  if (loading) {
    return (
      <AppLayout context="diagnostics">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (!visit || !visitId) {
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

  const { patient, testOrders } = visit;
  const currentYear = new Date().getFullYear();
  const age = patient.yearOfBirth ? currentYear - patient.yearOfBirth : null;

  // After a partial release the visit stays open with a fresh DRAFT version.
  // Surface the prior finalized versions so staff understand that edits to
  // already-sent tests will only appear in the next version, not retroactively.
  const versions = visit.report?.versions ?? [];
  const finalizedVersions = versions.filter((v) => v.status === 'FINALIZED');
  const lastFinalizedVersion = finalizedVersions.reduce<typeof versions[number] | null>(
    (latest, v) => (latest && (latest.versionNum ?? 0) > (v.versionNum ?? 0) ? latest : v),
    null,
  );
  // Map every previously-sent test order to the FIRST version it appeared in,
  // so per-row hints can show the exact "Sent in v{N}" label. Iterating in
  // ascending version order guarantees we record the earliest occurrence.
  const sentTestOrderVersions = new Map<string, number>();
  const finalizedAsc = [...finalizedVersions].sort(
    (a, b) => (a.versionNum ?? 0) - (b.versionNum ?? 0),
  );
  for (const v of finalizedAsc) {
    for (const r of v.testResults ?? []) {
      if (r.testOrderId && !sentTestOrderVersions.has(r.testOrderId)) {
        sentTestOrderVersions.set(r.testOrderId, v.versionNum ?? 0);
      }
    }
  }
  const sentTestOrderCount = sentTestOrderVersions.size;
  const nextVersionNum = (lastFinalizedVersion?.versionNum ?? 0) + 1;
  /** Earliest version any of the given order ids was sent in, or null. */
  const earliestSentVersion = (orderIds: string[]): number | null => {
    let earliest: number | null = null;
    for (const id of orderIds) {
      const v = sentTestOrderVersions.get(id);
      if (v !== undefined && (earliest === null || v < earliest)) earliest = v;
    }
    return earliest;
  };

  const computeFlag = (value: number, min: number, max: number): 'NORMAL' | 'HIGH' | 'LOW' | null => {
    if (min === 0 && max === 0) return null;
    if (min > 0 && value < min) return 'LOW';
    if (max > 0 && value > max) return 'HIGH';
    return 'NORMAL';
  };

  const handleValueChange = (testId: string, value: string) => {
    setResults((prev) => {
      const updated = { ...prev, [testId]: value };
      const changedCode = testIdToCodeMap.get(testId);
      return changedCode
        ? recalculateDerivedResults(updated, changedCode)
        : updated;
    });
  };

  const togglePanel = (orderId: string) => {
    setExpandedPanels((prev) => ({
      ...prev,
      [orderId]: !prev[orderId],
    }));
  };

  const getAllTestsForValidation = (): Array<{ testId: string; code: string; min: number; max: number; isDerived: boolean }> => {
    const allTests: Array<{ testId: string; code: string; min: number; max: number; isDerived: boolean }> = [];

    testOrders.forEach((order) => {
      // EXTERNAL_UPLOAD orders carry their result as a PDF — never as values.
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return;
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        order.childTests.forEach((child) => {
          allTests.push({
            testId: child.id,
            code: child.code,
            min: child.referenceRange.min,
            max: child.referenceRange.max,
            isDerived: !!child.isDerived,
          });
        });
      } else {
        allTests.push({
          testId: order.testId,
          code: order.testCode,
          min: order.referenceRange.min,
          max: order.referenceRange.max,
          isDerived: !!order.isDerived,
        });
      }
    });

    return allTests;
  };

  const handleSaveDraft = () => {
    const allTests = getAllTestsForValidation();
    const extreme: string[] = [];

    allTests.forEach((test) => {
      if (textLayoutByTestId.has(test.testId)) {
        return;
      }

      const valueStr = results[test.testId];
      const value = valueStr ? parseFloat(valueStr) : null;
      if (value !== null && test.max > 0) {
        if (value > test.max * 2 || (test.min > 0 && value < test.min / 2)) {
          extreme.push(test.code);
        }
      }
    });

    if (extreme.length > 0) {
      setExtremeValues(extreme);
      setShowWarning(true);
      return;
    }

    saveResults();
  };

  const saveResults = async (partialSelection?: string[]) => {
    setSaving(true);
    // Cancel any pending debounced auto-save so we don't fire two POSTs back-to-back.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    try {
      // If an auto-save is already mid-flight, let it finish before we POST again.
      if (inFlightSaveRef.current) {
        await inFlightSaveRef.current;
      }

      const hasAnyExternalUpload = Object.values(uploadsByOrder).some((arr) => arr && arr.length > 0);
      const result = await persistDraft();
      // Carry the per-test selection (if any) forward to the preview page so
      // the eventual /release-partial call only ships the chosen test orders.
      // When omitted the preview falls back to "release everything in draft",
      // matching the historical behavior.
      const navState =
        partialSelection && partialSelection.length > 0
          ? { state: { partialSelection } as { partialSelection: string[] } }
          : undefined;

      if (result === 'empty') {
        // Pure external-upload visits won't have any value rows — that's fine,
        // the uploaded PDFs carry the report.
        if (!hasAnyExternalUpload) {
          toast.error('Please enter at least one test result');
          return;
        }
        toast.success('Uploads saved');
        navigate(`/diagnostics/preview/${visitId}`, navState);
        return;
      }

      if (result === 'saved') {
        dirtyRef.current = false;
        setLastSavedAt(Date.now());
        setAutoSaveStatus('saved');
        toast.success('Results saved as draft');
        navigate(`/diagnostics/preview/${visitId}`, navState);
        return;
      }

      // result === 'failed'
      setAutoSaveStatus('error');
      toast.error('Failed to save results');
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmSave = () => {
    setShowWarning(false);
    saveResults();
  };

  const handleDerivedModeToggle = (testId: string, makeManual: boolean) => {
    setDerivedManualOverrides((prev) => {
      if (makeManual) {
        return {
          ...prev,
          [testId]: true,
        };
      }

      const next = { ...prev };
      delete next[testId];
      return next;
    });
  };

  const renderExternalUploadOrder = (order: TestOrder) => {
    const uploads = uploadsByOrder[order.id] || [];
    const isThisOrderUploading = uploadingOrderId === order.id;
    const formatBytes = (n: number) => {
      if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    };
    const fileViewUrl = (uploadId: string) =>
      `${API_BASE}/external-uploads/${uploadId}`;

    return (
      <div key={order.id} className="overflow-hidden rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-3">
          <div>
            <div className="font-semibold">{order.testName}</div>
            <div className="text-xs text-muted-foreground">
              External report (PDF) — uploaded files merge into the final report.
            </div>
          </div>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              uploads.length === 0
                ? 'bg-amber-100 text-amber-700'
                : 'bg-emerald-100 text-emerald-700'
            )}
          >
            {uploads.length === 0
              ? '0 files'
              : `${uploads.length} file${uploads.length === 1 ? '' : 's'} uploaded`}
          </span>
        </div>
        <div className="space-y-3 p-4">
          {uploads.length > 0 && (
            <ul className="space-y-2">
              {uploads.map((upload) => (
                <li
                  key={upload.id}
                  className="flex items-center justify-between gap-2 rounded border bg-background px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{upload.originalFilename}</div>
                    <div className="text-xs text-muted-foreground">
                      {upload.pageCount != null ? `${upload.pageCount} page${upload.pageCount === 1 ? '' : 's'} · ` : ''}
                      {formatBytes(upload.fileSizeBytes)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <a
                      href={fileViewUrl(upload.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      View
                    </a>
                    <button
                      type="button"
                      onClick={() => deleteUpload(upload.id, order.id)}
                      className="text-xs font-medium text-red-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label
              className={cn(
                'inline-flex cursor-pointer items-center gap-2 rounded border border-dashed px-3 py-2 text-sm font-medium hover:bg-muted/50',
                isThisOrderUploading && 'pointer-events-none opacity-60'
              )}
            >
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                disabled={isThisOrderUploading}
                onChange={async (e) => {
                  const files = Array.from(e.target.files || []);
                  e.target.value = '';
                  for (const file of files) {
                    await uploadFileForOrder(order.id, file);
                  }
                }}
                multiple
              />
              {isThisOrderUploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Uploading…
                </>
              ) : uploads.length === 0 ? (
                'Upload PDF'
              ) : (
                'Add another PDF'
              )}
            </label>
          </div>
        </div>
      </div>
    );
  };

  const renderTestInput = (
    testId: string,
    testName: string,
    testCode: string,
    referenceRange: ReferenceRange,
    isSubTest: boolean = false,
    isDerived: boolean = false
  ) => {
    const valueStr = results[testId] || '';
    const value = valueStr ? parseFloat(valueStr) : null;
    const flag = value !== null
      ? computeFlag(value, referenceRange.min, referenceRange.max)
      : null;
    const isManualDerived = isDerived && !!derivedManualOverrides[testId];
    const isAutoDerived = isDerived && !isManualDerived;

    const hasNumericRange = referenceRange.min > 0 || referenceRange.max > 0;
    const inputConfig = testInputConfigByTestId.get(testId) ?? DEFAULT_INPUT_CONFIG;
    const usePresetCombobox =
      !isAutoDerived &&
      (inputConfig.inputType === 'TEXT_WITH_PRESETS' || inputConfig.inputType === 'SELECT_ONLY') &&
      inputConfig.valueOptions.length > 0;

    // How wide should the Value cell be?
    //   - NUMERIC          → 1 col (120px) — numbers fit fine
    //   - FREE_TEXT        → if test has reference text ("Negative" etc), span 2
    //                        cols (absorb Flag only, keep Reference visible);
    //                        otherwise span 3 (absorb both).
    //   - Combobox / Select→ span 3 cols. Long morphology phrasings need width;
    //                        these tests rarely have a meaningful reference.
    const hasReferenceContent = !!referenceRange.text || hasNumericRange;
    const valueCellSpan: 1 | 2 | 3 = (() => {
      if (isAutoDerived) return 1; // derived numeric tests stay tight
      if (inputConfig.inputType === 'NUMERIC') return 1;
      if (usePresetCombobox) return 3;
      // FREE_TEXT
      return hasReferenceContent ? 2 : 3;
    })();
    const showReferenceCell = valueCellSpan < 3;
    const showFlagCell = valueCellSpan < 2;

    return (
      <div
        key={testId}
        className={cn(
          'grid gap-3 border-b py-3 last:border-0 md:grid-cols-[1fr_120px_180px_80px] md:items-center md:gap-4',
          isSubTest ? 'md:pl-4' : ''
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Label className={cn('font-medium', isSubTest ? 'text-sm' : 'text-base')}>
              {testName}
            </Label>
            <span className="text-xs text-muted-foreground">({testCode})</span>
            {isDerived && (
              <span
                className={cn(
                  'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium',
                  isManualDerived
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-blue-100 text-blue-700'
                )}
              >
                {isManualDerived ? 'Manual' : 'Auto'}
              </span>
            )}
          </div>
        </div>

        {/*
          Value cell span adapts to input type:
          • Numeric           → 1 col (120px)
          • Free text w/ ref  → 2 cols (200px, Reference still shown)
          • Free text no ref  → 3 cols (380px)
          • Combobox / Select → 3 cols (380px) — fits long morphology phrasings
        */}
        <div className={cn(
          'space-y-1',
          valueCellSpan === 2 && 'md:col-span-2',
          valueCellSpan === 3 && 'md:col-span-3'
        )}>
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
            Value
          </span>
          <div className="flex items-center gap-2">
            {usePresetCombobox ? (
              <TestValueCombobox
                value={valueStr}
                onChange={(next) => handleValueChange(testId, next)}
                options={inputConfig.valueOptions}
                allowCustom={inputConfig.inputType === 'TEXT_WITH_PRESETS'}
                placeholder="Select value…"
                disabled={isAutoDerived}
              />
            ) : (
              <Input
                type="text"
                inputMode={
                  inputConfig.inputType === 'FREE_TEXT'
                    ? 'text'
                    : hasNumericRange || inputConfig.inputType === 'NUMERIC'
                      ? 'decimal'
                      : 'text'
                }
                placeholder={isAutoDerived ? 'Auto-calculated' : 'Value'}
                value={valueStr}
                onChange={(e) => handleValueChange(testId, e.target.value)}
                readOnly={isAutoDerived}
                disabled={isAutoDerived}
                className={cn(
                  'text-center',
                  isAutoDerived && 'bg-muted cursor-not-allowed text-muted-foreground'
                )}
              />
            )}
            {isDerived && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 shrink-0 px-2 text-[11px]"
                onClick={() => handleDerivedModeToggle(testId, !isManualDerived)}
              >
                {isManualDerived ? 'Auto' : 'Edit'}
              </Button>
            )}
          </div>
        </div>

        {showReferenceCell && (
          <div className="space-y-1 text-sm text-muted-foreground md:text-center">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
              Reference Range
            </span>
            <div>
              {referenceRange.text ? (
                referenceRange.text
              ) : hasNumericRange ? (
                `${referenceRange.min || ''} – ${referenceRange.max || ''} ${referenceRange.unit}`
              ) : (
                '—'
              )}
            </div>
          </div>
        )}

        {showFlagCell && (
          <div className="space-y-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
              Flag
            </span>
            <div className="flex md:justify-center">
              {flag ? (
                <FlagBadge flag={flag} />
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderNarrativeInput = (
    testId: string,
    testName: string,
    testCode: string,
    placeholder: string,
    _isSubTest: boolean = false,
    panelDisplayName?: string,
    departmentName?: string
  ) => {
    const valueStr = results[testId] || '';

    return (
      <div key={testId} className="py-3">
        <ReportFramedNarrativeEditor
          value={valueStr}
          onChange={(nextValue) => handleValueChange(testId, nextValue)}
          patient={{
            name: visit?.patient.name || '',
            ageDisplay: visit?.patient.yearOfBirth
              ? `${new Date().getFullYear() - visit.patient.yearOfBirth} Years`
              : undefined,
            gender: visit?.patient.gender,
            patientNumber: undefined,
          }}
          visit={{
            billNumber: visit?.billNumber || '',
            createdAt: undefined,
            collectedAt: null,
            reportedAt: null,
            sampleType: null,
          }}
          departmentName={departmentName || 'Tests'}
          panelDisplayName={panelDisplayName || testName}
          testCode={testCode}
          placeholder={placeholder}
          onSurfaceStateChange={(state) => {
            if (activeSurfaceTestIdRef.current === testId) {
              setSharedToolbarState(state);
            }
          }}
          onActivate={(handle) => {
            activeSurfaceRef.current = handle;
            activeSurfaceTestIdRef.current = testId;
            setActiveSurfaceTestId(testId);
          }}
          onDeactivate={() => {
            // Don't clear immediately on blur — the user may be clicking a toolbar
            // button, which would lose focus on the contentEditable. Toolbar buttons
            // re-focus the surface via runCommand → editor.focus(). We only clear
            // when another editor takes focus or the page unmounts.
          }}
        />
      </div>
    );
  };

  const countFilledResults = (order: TestOrder): number => {
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.filter((child) =>
        hasResultValue(results[child.id], textLayoutByTestId.get(child.id))
      ).length;
    }
    return hasResultValue(results[order.testId], textLayoutByTestId.get(order.testId)) ? 1 : 0;
  };

  const getTotalTests = (order: TestOrder): number => {
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.length;
    }
    return 1;
  };

  // Group orders by panel.id within each department to handle the new architecture
  // where each panel parameter is a separate TestOrder but shares the same panel.id
  type PanelGroup = {
    type: 'panel';
    panelId: string;
    panelName: string;
    panelDisplayName: string;
    panelLayoutType: string;
    panelMethodText: string | null;
    panelMethodItalic: boolean;
    orders: TestOrder[];
  };
  type SingleOrder = {
    type: 'single';
    order: TestOrder;
  };
  type OrderGroup = PanelGroup | SingleOrder;

  const departmentGroups = Array.from(
    testOrders.reduce((groups, order) => {
      const groupKey = order.department?.id || order.department?.name || 'other-tests';
      const groupName = order.department?.name || 'Other Tests';

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          id: groupKey,
          name: groupName,
          orders: [],
        });
      }

      groups.get(groupKey)!.orders.push(order);
      return groups;
    }, new Map<string, { id: string; name: string; orders: TestOrder[] }>())
  ).map(([, group]) => {
    // Within each department, group orders by panel.id
    const panelGroups = new Map<string, PanelGroup>();
    const orderGroups: OrderGroup[] = [];

    for (const order of group.orders) {
      // If order has legacy childTests (isPanel with children), render as-is
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        orderGroups.push({ type: 'single', order });
        continue;
      }

      // If order has a panel.id, group with other orders of same panel
      if (order.panel?.id) {
        if (!panelGroups.has(order.panel.id)) {
          panelGroups.set(order.panel.id, {
            type: 'panel',
            panelId: order.panel.id,
            panelName: order.panel.name,
            panelDisplayName: order.panel.displayName,
            panelLayoutType: order.panel.layoutType,
            panelMethodText: order.panel.panelMethodText || null,
            panelMethodItalic: order.panel.panelMethodItalic || false,
            orders: [],
          });
        }
        panelGroups.get(order.panel.id)!.orders.push(order);
      } else {
        // No panel - render as individual test
        orderGroups.push({ type: 'single', order });
      }
    }

    // Add panel groups to orderGroups (panels with only 1 order render as single)
    for (const panelGroup of panelGroups.values()) {
      if (panelGroup.orders.length === 1) {
        orderGroups.push({ type: 'single', order: panelGroup.orders[0] });
      } else {
        orderGroups.push(panelGroup);
      }
    }

    return {
      ...group,
      orderGroups,
    };
  });

  const getPanelTitle = (order: TestOrder) =>
    order.panel?.displayName || order.panel?.name || order.testName;

  const getPanelSubtitle = (order: TestOrder) => {
    const panelTitle = getPanelTitle(order);
    if (panelTitle !== order.testName) {
      return order.testName;
    }
    return null;
  };

  // True if anything renders an editable surface — value-input rows OR an upload zone.
  const hasReportableInputs = testOrders.some((order) => {
    if (order.workflowMode === 'EXTERNAL_UPLOAD') return true;
    if (!order.isPanel) return true;
    return order.childTests.length > 0;
  });

  // EXTERNAL_UPLOAD orders are only "ready" once at least one PDF is attached.
  // Used to block the Save Draft button until the user finishes uploading.
  const externalUploadOrdersMissingFiles = testOrders.filter((order) => {
    if (order.workflowMode !== 'EXTERNAL_UPLOAD') return false;
    return !uploadsByOrder[order.id] || uploadsByOrder[order.id].length === 0;
  });
  const hasMissingExternalUploads = externalUploadOrdersMissingFiles.length > 0;

  // Per-test-order status used to drive the partial-release selector.
  //   'complete'      — order has real content (numeric value, edited narrative, or upload)
  //   'template-only' — order is a narrative whose only content is the unedited template
  //   'empty'         — order has no content yet
  type TestOrderStatus = 'complete' | 'template-only' | 'empty';
  const computeOrderStatus = (order: TestOrder): TestOrderStatus => {
    if (order.workflowMode === 'EXTERNAL_UPLOAD') {
      const uploads = uploadsByOrder[order.id];
      return uploads && uploads.length > 0 ? 'complete' : 'empty';
    }

    const ids: string[] =
      order.isPanel && order.childTests && order.childTests.length > 0
        ? order.childTests.map((c) => c.id)
        : [order.testId];

    let sawContent = false;
    let allTemplateOnly = true;
    let anyNarrative = false;

    for (const id of ids) {
      const layout = textLayoutByTestId.get(id);
      const value = results[id];
      const filled = hasResultValue(value, layout);
      if (!filled) {
        // Empty narrative slot in a multi-test panel still contributes — the
        // panel is incomplete, but for the purpose of "did anything actually
        // get filled in" it doesn't help. Treat the whole order as template-
        // only/empty unless another sub-test has real content.
        continue;
      }

      sawContent = true;

      if (isRichTextPanelLayout(layout)) {
        anyNarrative = true;
        const template = narrativeTemplateByTestId.get(id);
        const normalizedValue = normalizeRichTextForStorage(value);
        if (!template || normalizedValue !== template) {
          allTemplateOnly = false;
        }
      } else {
        // Non-narrative test with content is unambiguously complete.
        allTemplateOnly = false;
      }
    }

    if (!sawContent) return 'empty';
    if (anyNarrative && allTemplateOnly) return 'template-only';
    return 'complete';
  };

  const orderStatuses = new Map<string, TestOrderStatus>(
    testOrders.map((o) => [o.id, computeOrderStatus(o)] as const),
  );
  // Visit is "fully done" when every reportable order is `complete` — no
  // template-only narratives, no empty slots, no missing external uploads.
  const fullyDone =
    !hasMissingExternalUploads &&
    testOrders.length > 0 &&
    testOrders.every((o) => orderStatuses.get(o.id) === 'complete');
  // Orders that could appear in a partial release. Empty orders are excluded
  // entirely (nothing to ship). Template-only narratives are eligible but
  // pre-unchecked.
  const partialEligibleOrderIds = testOrders
    .filter((o) => orderStatuses.get(o.id) !== 'empty')
    .map((o) => o.id);
  const defaultPartialSelectionIds = testOrders
    .filter((o) => orderStatuses.get(o.id) === 'complete')
    .map((o) => o.id);

  // True if any test in this visit uses the WYSIWYG framed narrative editor.
  // Used to decide whether to show the sticky shared rich-text toolbar at the
  // top of the page.
  const hasNarrativeTests = testOrders.some((order) => {
    if (isRichTextPanelLayout(textLayoutByTestId.get(order.testId))) return true;
    if (order.isPanel && order.childTests) {
      return order.childTests.some((child) =>
        isRichTextPanelLayout(textLayoutByTestId.get(child.id))
      );
    }
    return false;
  });

  // True if any test in this visit needs the structured Test/Value/Range/Flag
  // column header. Narrative tests don't, so the header is hidden when every
  // test is narrative — it would just confuse the user (radiology has no
  // numeric "value" or "reference range").
  const hasNonNarrativeTests = testOrders.some((order) => {
    if (order.workflowMode === 'EXTERNAL_UPLOAD') return false;
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.some(
        (child) => !isRichTextPanelLayout(textLayoutByTestId.get(child.id))
      );
    }
    return !isRichTextPanelLayout(textLayoutByTestId.get(order.testId));
  });

  return (
    <AppLayout context="diagnostics">
      <div className={cn('mx-auto space-y-6 animate-fade-in', hasNarrativeTests ? 'max-w-6xl' : 'max-w-4xl')}>
        {/* Prior partial-release banner — shown when one or more partial reports
            have already been sent to the patient. Edits to already-sent tests
            only appear in the next finalized version (this DRAFT). */}
        {finalizedVersions.length > 0 && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 flex items-start gap-2">
            <svg
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-700"
              fill="currentColor"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M5 9V7a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 17 10.5v6A1.5 1.5 0 0 1 15.5 18h-11A1.5 1.5 0 0 1 3 16.5v-6A1.5 1.5 0 0 1 4.5 9H5Zm2 0h6V7a3 3 0 1 0-6 0v2Z"
                clipRule="evenodd"
              />
            </svg>
            <div>
              <p className="font-medium">
                {finalizedVersions.length === 1
                  ? `Version ${lastFinalizedVersion?.versionNum ?? 1} already sent to patient${
                      lastFinalizedVersion?.finalizedAt
                        ? ` on ${new Date(lastFinalizedVersion.finalizedAt).toLocaleString()}`
                        : ''
                    }.`
                  : `${finalizedVersions.length} partial reports already sent (latest: v${lastFinalizedVersion?.versionNum ?? finalizedVersions.length}).`}
                {sentTestOrderCount > 0 && (
                  <span> {sentTestOrderCount} test{sentTestOrderCount === 1 ? '' : 's'} already delivered.</span>
                )}
              </p>
              <p className="mt-0.5 text-blue-800">
                You're editing version {nextVersionNum}. Earlier versions are locked — any edits here will only appear in v{nextVersionNum}, not retroactively.
              </p>
            </div>
          </div>
        )}

        {/* Visit Summary - Pinned */}
        <Card className="border-primary/20 bg-accent/30">
          <CardContent className="pt-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-xl font-bold">{patient.name}</h2>
                <p className="text-muted-foreground">
                  {age ? `${age} yrs` : ''} | {patient.gender}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono font-bold">{visit.billNumber}</p>
                <p className="text-sm text-muted-foreground">{testOrders.length} test(s) ordered</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Shared rich-text toolbar — sticky at the top of the page so it stays
            in reach as the user scrolls through long narrative reports. Routes
            commands to whichever framed editor is currently focused. Hidden
            entirely when this visit has no narrative tests. */}
        {hasNarrativeTests && (
          <div className="sticky top-0 z-30 -mx-2 px-2 py-2 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
            <RichTextToolbar
              state={sharedToolbarState}
              active={activeSurfaceTestId !== null}
              onCommand={(command, value) => {
                activeSurfaceRef.current?.runCommand(command, value);
              }}
            />
          </div>
        )}

        {/* Test Results */}
        <Card>
          <CardHeader>
            <CardTitle>Enter Test Results</CardTitle>
            {hasNonNarrativeTests && (
              <div className="hidden border-b pb-2 pt-4 text-xs uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[1fr_120px_180px_80px] md:gap-4">
                <div>Test Name</div>
                <div className="text-center">Value</div>
                <div className="text-center">Reference Range</div>
                <div className="text-center">Flag</div>
              </div>
            )}
          </CardHeader>
          <CardContent className="space-y-6 pt-0" onBlur={handleFormBlur}>
            {!hasReportableInputs ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No reportable test items are linked to this visit yet. Add the required backing test item to the panel definition, then reopen this visit.
              </div>
            ) : departmentGroups.map((department) => (
              <div key={department.id} className="space-y-3">
                <div className="flex items-center gap-3 pt-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    {department.name}
                  </h3>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="space-y-3">
                  {department.orderGroups.map((group) => {
                    // Narrative-only groups (radiology / imaging / text-only) skip
                    // the collapsible panel chrome and render directly as report-
                    // framed editors — the frame itself shows the panel/test name,
                    // so the outer container would just duplicate it.
                    const isNarrativeOnlyGroup =
                      group.type === 'panel'
                        ? group.orders.every((o) =>
                            isRichTextPanelLayout(textLayoutByTestId.get(o.testId))
                          )
                        : (() => {
                            const o = group.order;
                            if (o.workflowMode === 'EXTERNAL_UPLOAD') return false;
                            if (o.isPanel && o.childTests && o.childTests.length > 0) {
                              return o.childTests.every((c) =>
                                isRichTextPanelLayout(textLayoutByTestId.get(c.id))
                              );
                            }
                            return isRichTextPanelLayout(
                              textLayoutByTestId.get(o.testId)
                            );
                          })();

                    if (isNarrativeOnlyGroup) {
                      if (group.type === 'panel') {
                        return (
                          <div key={group.panelId} className="space-y-4">
                            {group.orders.map((order) => {
                              const textLayout = textLayoutByTestId.get(order.testId);
                              return renderNarrativeInput(
                                order.testId,
                                order.testName,
                                order.testCode,
                                textLayout === 'IMAGING_NARRATIVE'
                                  ? 'Enter narrative report...'
                                  : 'Enter text result...',
                                false,
                                group.panelDisplayName || group.panelName,
                                department.name
                              );
                            })}
                          </div>
                        );
                      }

                      const order = group.order;
                      // Single narrative order — could be a legacy panel with all-narrative children
                      // or a standalone narrative test.
                      if (order.isPanel && order.childTests && order.childTests.length > 0) {
                        return (
                          <div key={order.id} className="space-y-4">
                            {order.childTests.map((child) => {
                              const textLayout = textLayoutByTestId.get(child.id);
                              return renderNarrativeInput(
                                child.id,
                                child.name,
                                child.code,
                                textLayout === 'IMAGING_NARRATIVE'
                                  ? 'Enter narrative report...'
                                  : 'Enter text result...',
                                false,
                                order.panel?.displayName || order.panel?.name || order.testName,
                                department.name
                              );
                            })}
                          </div>
                        );
                      }

                      const textLayout = textLayoutByTestId.get(order.testId);
                      return (
                        <div key={order.id}>
                          {renderNarrativeInput(
                            order.testId,
                            order.testName,
                            order.testCode,
                            textLayout === 'IMAGING_NARRATIVE'
                              ? 'Enter narrative report...'
                              : 'Enter text result...',
                            false,
                            order.panel?.displayName || order.panel?.name || order.testName,
                            department.name
                          )}
                        </div>
                      );
                    }

                    // Render grouped panel (multiple orders with same panel.id)
                    if (group.type === 'panel') {
                      const panelGroup = group;
                      const isExpanded = expandedPanels[panelGroup.panelId] ?? true;
                      const filled = panelGroup.orders.filter((o) =>
                        hasResultValue(results[o.testId], textLayoutByTestId.get(o.testId))
                      ).length;
                      const total = panelGroup.orders.length;

                      return (
                        <div key={panelGroup.panelId} className="overflow-hidden rounded-lg border">
                          <button
                            onClick={() => togglePanel(panelGroup.panelId)}
                            className="flex w-full flex-col gap-3 bg-muted/50 p-4 text-left transition-colors hover:bg-muted/70 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-3">
                                <span className="text-lg font-semibold">{panelGroup.panelDisplayName || panelGroup.panelName}</span>
                                <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                                  {total} parameters
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  ({filled}/{total} filled)
                                </span>
                                {(() => {
                                  const sentV = earliestSentVersion(panelGroup.orders.map((o) => o.id));
                                  if (sentV === null) return null;
                                  return (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 border border-blue-200"
                                      title={`This panel was sent to the patient in version ${sentV}. Edits here will only appear in v${nextVersionNum}.`}
                                    >
                                      <Lock className="h-3 w-3" />
                                      Sent in v{sentV}
                                    </span>
                                  );
                                })()}
                              </div>
                              {panelGroup.panelMethodText && (
                                <div className={cn(
                                  'text-sm text-muted-foreground',
                                  panelGroup.panelMethodItalic && 'italic'
                                )}>
                                  Method : {panelGroup.panelMethodText}
                                </div>
                              )}
                            </div>
                            <div className="flex justify-end">
                              {isExpanded ? (
                                <ChevronUp className="h-5 w-5 text-muted-foreground" />
                              ) : (
                                <ChevronDown className="h-5 w-5 text-muted-foreground" />
                              )}
                            </div>
                          </button>

                          {isExpanded && (
                            <div className="bg-card p-4">
                              {panelGroup.orders.map((order) => {
                                const textLayout = textLayoutByTestId.get(order.testId);
                                if (isRichTextPanelLayout(textLayout)) {
                                  return renderNarrativeInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    textLayout === 'IMAGING_NARRATIVE'
                                      ? 'Enter narrative report...'
                                      : 'Enter text result...',
                                    true
                                  );
                                }

                                return renderTestInput(
                                  order.testId,
                                  order.testName,
                                  order.testCode,
                                  order.referenceRange,
                                  true,
                                  !!order.isDerived
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    }

                    // Render single order (legacy panel with childTests or individual test)
                    const order = group.order;
                    if (order.workflowMode === 'EXTERNAL_UPLOAD') {
                      return renderExternalUploadOrder(order);
                    }
                    const isLegacyPanel = order.isPanel && order.childTests && order.childTests.length > 0;
                    const isExpanded = expandedPanels[order.id] ?? false;
                    const filled = countFilledResults(order);
                    const total = getTotalTests(order);
                    const panelTitle = getPanelTitle(order);
                    const panelSubtitle = getPanelSubtitle(order);
                    const panelMethodText = order.panel?.panelMethodText || null;

                    return (
                      <div key={order.id} className="overflow-hidden rounded-lg border">
                        {isLegacyPanel ? (
                          <>
                            <button
                              onClick={() => togglePanel(order.id)}
                              className="flex w-full flex-col gap-3 bg-muted/50 p-4 text-left transition-colors hover:bg-muted/70 sm:flex-row sm:items-center sm:justify-between"
                            >
                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center gap-3">
                                  <span className="text-lg font-semibold">{panelTitle}</span>
                                  {panelSubtitle && (
                                    <span className="text-sm text-muted-foreground">
                                      {panelSubtitle}
                                    </span>
                                  )}
                                  <span className="rounded-full bg-primary/10 px-2 py-1 text-xs text-primary">
                                    {order.childTests.length} parameters
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    ({filled}/{total} filled)
                                  </span>
                                  {sentTestOrderVersions.get(order.id) !== undefined && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 border border-blue-200"
                                      title={`Sent to patient in version ${sentTestOrderVersions.get(order.id)}. Edits will only appear in v${nextVersionNum}.`}
                                    >
                                      <Lock className="h-3 w-3" />
                                      Sent in v{sentTestOrderVersions.get(order.id)}
                                    </span>
                                  )}
                                </div>
                                {panelMethodText && (
                                  <div className={cn(
                                    'text-sm text-muted-foreground',
                                    order.panel?.panelMethodItalic && 'italic'
                                  )}>
                                    Method : {panelMethodText}
                                  </div>
                                )}
                              </div>
                              <div className="flex justify-end">
                                {isExpanded ? (
                                  <ChevronUp className="h-5 w-5 text-muted-foreground" />
                                ) : (
                                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                                )}
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="bg-card p-4">
                                {order.childTests.map((child) => {
                                  const textLayout = textLayoutByTestId.get(child.id);
                                  if (isRichTextPanelLayout(textLayout)) {
                                    return renderNarrativeInput(
                                      child.id,
                                      child.name,
                                      child.code,
                                      textLayout === 'IMAGING_NARRATIVE'
                                        ? 'Enter narrative report...'
                                        : 'Enter text result...',
                                      true
                                    );
                                  }

                                  return renderTestInput(
                                    child.id,
                                    child.name,
                                    child.code,
                                    child.referenceRange,
                                    true,
                                    !!child.isDerived
                                  );
                                })}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="border-b bg-muted/30 px-4 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="font-semibold">{order.testName}</div>
                                {sentTestOrderVersions.get(order.id) !== undefined && (
                                  <span
                                    className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-800 border border-blue-200"
                                    title={`Sent to patient in version ${sentTestOrderVersions.get(order.id)}. Edits will only appear in v${nextVersionNum}.`}
                                  >
                                    <Lock className="h-3 w-3" />
                                    Sent in v{sentTestOrderVersions.get(order.id)}
                                  </span>
                                )}
                              </div>
                              {panelMethodText && (
                                <div className={cn(
                                  'mt-1 text-sm text-muted-foreground',
                                  order.panel?.panelMethodItalic && 'italic'
                                )}>
                                  Method : {panelMethodText}
                                </div>
                              )}
                            </div>
                            <div className="p-4">
                              {(() => {
                                const textLayout = textLayoutByTestId.get(order.testId);
                                if (isRichTextPanelLayout(textLayout)) {
                                  return renderNarrativeInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    textLayout === 'IMAGING_NARRATIVE'
                                      ? 'Enter narrative report...'
                                      : 'Enter text result...'
                                  );
                                }

                                return renderTestInput(
                                  order.testId,
                                  order.testName,
                                  order.testCode,
                                  order.referenceRange,
                                  false,
                                  !!order.isDerived
                                );
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {hasMissingExternalUploads && (
              <p className="mt-4 text-sm text-amber-700">
                Upload a PDF for {externalUploadOrdersMissingFiles.map((o) => o.testName).join(', ')} before saving.
              </p>
            )}
            {(() => {
              // Button label flips between full-finalize and partial-release.
              // `fullyDone` (computed above) only returns true when every order
              // is genuinely complete — template-only narratives count as
              // incomplete here so the staff sees the "partial" path and gets
              // the selector dialog.
              const buttonLabel = fullyDone
                ? 'Review & Finalize'
                : 'Continue with Partial Report';

              const handleClick = () => {
                if (fullyDone || partialEligibleOrderIds.length <= 1) {
                  // Nothing to choose between — save & navigate. If exactly one
                  // order is eligible, pre-select it so the backend ships only
                  // that one (avoids accidentally including a template-only
                  // narrative that happens to also be eligible).
                  const single =
                    !fullyDone && partialEligibleOrderIds.length === 1
                      ? partialEligibleOrderIds
                      : undefined;
                  // Reuse the existing extreme-value validation flow so we
                  // don't bypass the warning dialog for fully-done visits.
                  if (fullyDone) {
                    handleSaveDraft();
                    return;
                  }
                  // For the single-order partial path, validate then save with selection.
                  void saveResults(single);
                  return;
                }
                // Multiple orders eligible — open the selector dialog.
                setPartialDialogOpen(true);
              };

              return (
                <>
                  {renderAutoSaveStatus(autoSaveStatus, lastSavedAt)}
                  <Button
                    className="w-full mt-2"
                    size="lg"
                    onClick={handleClick}
                    disabled={saving || !hasReportableInputs || hasMissingExternalUploads}
                  >
                    {saving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="mr-2 h-4 w-4" />
                    )}
                    {saving ? 'Saving...' : buttonLabel}
                  </Button>
                </>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Partial-release selector — opens when staff hits "Continue with
          Partial Report" and there's a real choice to make. Smart-defaulted
          so most clicks are pass-through; the explicit step prevents shipping
          template-only narratives that look "ready" by row presence alone. */}
      <PartialReleaseSelectorDialog
        open={partialDialogOpen}
        onOpenChange={setPartialDialogOpen}
        groups={(() => {
          const groupMap = new Map<string, PartialReleaseGroup>();
          testOrders.forEach((order) => {
            const status = orderStatuses.get(order.id);
            if (status === 'empty') return;

            const deptName = order.department?.name || 'Tests';
            if (!groupMap.has(deptName)) {
              groupMap.set(deptName, { departmentName: deptName, orders: [] });
            }

            // Build a status hint per order. The hint is the only place where
            // staff sees *why* a test is/isn't pre-checked.
            let hint: string | undefined;
            let hintVariant: 'normal' | 'warning' | undefined;
            let sublabel: string | undefined;

            if (order.workflowMode === 'EXTERNAL_UPLOAD') {
              const count = uploadsByOrder[order.id]?.length ?? 0;
              hint = `${count} file${count === 1 ? '' : 's'} uploaded`;
            } else if (status === 'template-only') {
              hint = 'Template only — not edited yet';
              hintVariant = 'warning';
            } else {
              // Summarise content for non-narrative tests so staff sees the
              // actual value before deciding to release.
              const ids =
                order.isPanel && order.childTests && order.childTests.length > 0
                  ? order.childTests.map((c) => c.id)
                  : [order.testId];
              const filledIds = ids.filter((id) =>
                hasResultValue(results[id], textLayoutByTestId.get(id)),
              );
              if (
                ids.length === 1 &&
                !isRichTextPanelLayout(textLayoutByTestId.get(ids[0]))
              ) {
                const v = results[ids[0]];
                if (v) sublabel = `value: ${v}`;
              } else if (filledIds.length > 0) {
                hint = `${filledIds.length} of ${ids.length} parameters entered`;
              }
            }

            const label = order.panel?.displayName || order.panel?.name || order.testName;
            groupMap.get(deptName)!.orders.push({
              id: order.id,
              label,
              sublabel,
              hint,
              hintVariant,
              defaultChecked: status === 'complete',
            });
          });
          return Array.from(groupMap.values());
        })()}
        busy={saving}
        onConfirm={(selectedOrderIds) => {
          setPartialDialogOpen(false);
          void saveResults(selectedOrderIds);
        }}
      />

      {/* Extreme Value Warning */}
      <AlertDialog open={showWarning} onOpenChange={setShowWarning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Extreme Values Detected
            </AlertDialogTitle>
            <AlertDialogDescription>
              The following tests have values significantly outside the normal range:
              <ul className="mt-2 list-disc list-inside font-medium text-foreground">
                {extremeValues.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <p className="mt-2">Please verify these values are correct before proceeding.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go Back & Edit</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave}>
              Acknowledge & Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default DiagnosticsResultEntry;

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ReportFramedNarrativeEditor } from '@/components/diagnostics/ReportFramedNarrativeEditor';
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
  richTextToPlainText,
} from '@/lib/richText';
import { formatPatientName } from '@/lib/patientDisplay';

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

type ResultKey = string;

function makeResultKey(testOrderId: string, testId: string): ResultKey {
  return `${testOrderId}:${testId}`;
}

function shouldUseTextInput(
  _testName: string,
  _testCode: string,
  referenceRange: ReferenceRange
): boolean {
  const hasNumericRange = referenceRange.min > 0 || referenceRange.max > 0;
  if (hasNumericRange) return false;
  return true;
}

function getEffectiveInputConfig(
  config: TestInputConfig,
  testName: string,
  testCode: string,
  referenceRange: ReferenceRange
): TestInputConfig {
  if (
    config.inputType === 'NUMERIC' &&
    !config.defaultValue &&
    config.valueOptions.length === 0 &&
    shouldUseTextInput(testName, testCode, referenceRange)
  ) {
    return { ...config, inputType: 'FREE_TEXT' };
  }

  return config;
}

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
  productId?: string;
  product?: {
    id: string;
    name: string;
    code: string;
  } | null;
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
  noReportAt?: string | null;
  noReportReason?: string | null;
  noReportBy?: string | null;
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
  const { token, user } = useAuthStore();
  // Staff/sales can enter and save results but never finalize, so the CTA must
  // not promise finalization to them — they hand off to owner / lab incharge.
  const canFinalize = user?.role === 'owner' || user?.role === 'lab_incharge';

  const [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  // Per result-row signer name override — what the radiologist types in the
  // "Doctor's Name" input below each narrative editor. Empty string = unset.
  // Round-trips through POST/GET so the value survives reloads, and flows
  // into the report snapshot at finalize so the PDF prints "{name} /
  // {Consultant Radiologist}" above the designation.
  const [signerNameByResultKey, setSignerNameByResultKey] = useState<Record<string, string>>({});
  const [derivedManualOverrides, setDerivedManualOverrides] = useState<Record<string, boolean>>({});
  const [showWarning, setShowWarning] = useState(false);
  const [extremeValues, setExtremeValues] = useState<string[]>([]);
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});
  // Uploads keyed by testOrderId. Populated from /api/external-uploads/by-visit on mount
  // and mutated locally as the user uploads / deletes files.
  const [uploadsByOrder, setUploadsByOrder] = useState<Record<string, ExternalUpload[]>>({});
  const [uploadingOrderId, setUploadingOrderId] = useState<string | null>(null);
  const [noReportTarget, setNoReportTarget] = useState<{ orderId: string; testName: string } | null>(null);
  const [noReportReasonText, setNoReportReasonText] = useState('');
  const [noReportBusy, setNoReportBusy] = useState(false);

  // Auto-save: debounced background persistence so techs never have to think
  // about saving. Status drives the inline indicator above the explicit button.
  type AutoSaveStatus = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error';
  const [autoSaveStatus, setAutoSaveStatus] = useState<AutoSaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const dirtyRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightSaveRef = useRef<Promise<'saved' | 'empty' | 'failed'> | null>(null);
  // Set when an auto-save fires while another save is in flight. The current
  // save can't include those newer edits, so we re-fire once it completes.
  const pendingResaveRef = useRef(false);
  // Result keys whose current `results[key]` value came from a prefill (narrative
  // template or numeric default), NOT from saved data or user input. These
  // must be excluded from auto-save POSTs — otherwise opening a visit and
  // editing one unrelated field would re-push every prefilled value back to
  // the server, silently overwriting whatever another staff member may have
  // typed in the meantime. Cleared per result key in handleValueChange when the
  // user actually edits.
  const prefilledResultKeysRef = useRef<Set<string>>(new Set());
  // Skips the very first results-changed render after fetchVisit populates state.
  const autoSavePrimedRef = useRef(false);
  // Fields the user changed in this session. Blank touched fields must still be
  // POSTed so the backend can delete any previously saved draft result.
  const touchedForSaveResultKeysRef = useRef<Set<string>>(new Set());

  // Partial-release selector dialog state. Opens when staff clicks
  // "Continue with Partial Report" and there's a real choice to make
  // (more than one ready test, or template-only narratives need to be
  // explicitly opted into).
  const [partialDialogOpen, setPartialDialogOpen] = useState(false);

  // Set of result keys whose narrative editor the radiologist has actually
  // *clicked into* this session. Used as the "did they touch it?" signal
  // for partial-release pre-selection: untouched narratives stay unchecked
  // by default so the unedited template can never silently ship.
  // Set of departmentIds that have an active SigningRule. When a department
  // has one configured, the per-narrative "Doctor's Name" input locks — the
  // rule is the source of truth for that department. The input re-enables
  // automatically once the rule is removed.
  const [departmentsWithSigningRule, setDepartmentsWithSigningRule] = useState<Set<string>>(
    () => new Set(),
  );

  const [touchedNarrativeResultKeys, setTouchedNarrativeResultKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const markNarrativeTouched = useCallback((resultKey: ResultKey) => {
    setTouchedNarrativeResultKeys((prev) => {
      if (prev.has(resultKey)) return prev;
      const next = new Set(prev);
      next.add(resultKey);
      return next;
    });
  }, []);

  const textLayoutByResultKey = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      const layoutType = order.panel?.layoutType;
      if (layoutType === 'TEXT_ONLY' || layoutType === 'IMAGING_NARRATIVE') {
        if (order.isPanel && order.childTests.length > 0) {
          order.childTests.forEach((child) =>
            map.set(makeResultKey(order.id, child.id), layoutType)
          );
        } else {
          map.set(makeResultKey(order.id, order.testId), layoutType);
        }
      }
    });

    return map;
  }, [visit]);

  // Map of result key → normalized narrativeTemplateHtml for narrative tests.
  // Used to detect when a narrative test still has only the unedited template
  // (so partial release pre-unchecks it instead of silently shipping the
  // boilerplate as if it were the actual report).
  const narrativeTemplateByResultKey = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      const layoutType = order.panel?.layoutType;
      if (!isRichTextPanelLayout(layoutType)) return;
      const tpl = normalizeNarrativeContent(order.panel?.narrativeTemplateHtml);
      if (!hasMeaningfulRichText(tpl)) return;
      const targets =
        order.isPanel && order.childTests.length > 0
          ? order.childTests.map((c) => makeResultKey(order.id, c.id))
          : [makeResultKey(order.id, order.testId)];
      targets.forEach((key) => map.set(key, tpl));
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
          testId: makeResultKey(order.id, order.testId),
          code: order.testCode,
          formulaExpression: order.formulaExpression,
          dependsOnCodes: order.dependsOnCodes,
        });
      }

      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          if (child.isDerived && child.formulaExpression && child.dependsOnCodes) {
            derived.push({
              testId: makeResultKey(order.id, child.id),
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

  // Build result-key-to-code map
  const resultKeyToCodeMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!visit) return map;

    visit.testOrders.forEach((order) => {
      map.set(makeResultKey(order.id, order.testId), order.testCode);
      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          map.set(makeResultKey(order.id, child.id), child.code);
        });
      }
    });

    return map;
  }, [visit]);

  // Map result key → entry-time input config (presets, default value, input type)
  const testInputConfigByResultKey = useMemo(() => {
    const map = new Map<string, TestInputConfig>();
    if (!visit) return map;
    visit.testOrders.forEach((order) => {
      if (order.inputConfig) map.set(makeResultKey(order.id, order.testId), order.inputConfig);
      if (order.isPanel && order.childTests) {
        order.childTests.forEach((child) => {
          if (child.inputConfig) map.set(makeResultKey(order.id, child.id), child.inputConfig);
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
        const code = resultKeyToCodeMap.get(id);
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
          prefilledResultKeysRef.current.delete(derivedTest.testId);
        } else {
          delete updated[derivedTest.testId];
          valuesByCode.delete(derivedTest.code);
        }
      }

      return updated;
    },
    [derivedManualOverrides, reverseDependencyMap, sortedDerivedTests, resultKeyToCodeMap]
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
          const fetchedTextLayoutByResultKey = new Map<string, string>();
          const fetchedNarrativeTemplateByResultKey = new Map<string, string>();

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
              const targetKeys =
                order.isPanel && order.childTests.length > 0
                  ? order.childTests.map((child) => makeResultKey(order.id, child.id))
                  : [makeResultKey(order.id, order.testId)];

              targetKeys.forEach((targetKey) => {
                fetchedTextLayoutByResultKey.set(targetKey, layoutType);
                if (isRichTextPanelLayout(layoutType)) {
                  fetchedNarrativeTemplateByResultKey.set(
                    targetKey,
                    normalizeNarrativeContent(order.panel?.narrativeTemplateHtml)
                  );
                }
              });
            }
          });

          // Initialize results from existing test results if any
          const initialResults: Record<string, string> = {};
          const initialManualOverrides: Record<string, boolean> = {};
          const initialSignerNames: Record<string, string> = {};

          if (data.report?.versions?.[0]?.testResults) {
            const latestVersion = data.report.versions[0];
            latestVersion.testResults.forEach((r: any) => {
              const resultKey = r.testOrderId
                ? makeResultKey(r.testOrderId, r.testId)
                : r.testId;
              const layoutType = fetchedTextLayoutByResultKey.get(resultKey);
              if (r.textValue) {
                initialResults[resultKey] =
                  isRichTextPanelLayout(layoutType)
                    ? normalizeNarrativeContent(r.textValue)
                    : r.textValue;
              } else if (r.value !== null) {
                initialResults[resultKey] = r.value.toString();
              }

              if (isManualDerivedOverride(r)) {
                initialManualOverrides[resultKey] = true;
              }

              if (typeof r.signerNameOverride === 'string' && r.signerNameOverride) {
                initialSignerNames[resultKey] = r.signerNameOverride;
              }
            });
          }

          // Track which result keys receive a prefill (template or default) so
          // auto-save can skip them until the user actually edits. Reset on
          // each fetch — the previous visit's prefills no longer apply.
          const prefilled = new Set<string>();

          fetchedNarrativeTemplateByResultKey.forEach((templateHtml, resultKey) => {
            if (!initialResults[resultKey] && hasMeaningfulRichText(templateHtml)) {
              initialResults[resultKey] = templateHtml;
              prefilled.add(resultKey);
            }
          });

          // Pre-fill input default values for tests that have one configured AND
          // have no saved/in-progress value yet. Defaults never overwrite saved data.
          data.testOrders.forEach((order: TestOrder) => {
            const apply = (resultKey: string, cfg?: TestInputConfig) => {
              if (!cfg?.defaultValue) return;
              if (initialResults[resultKey]) return;
              initialResults[resultKey] = cfg.defaultValue;
              prefilled.add(resultKey);
            };
            apply(makeResultKey(order.id, order.testId), order.inputConfig);
            if (order.isPanel && order.childTests) {
              order.childTests.forEach((child) =>
                apply(makeResultKey(order.id, child.id), child.inputConfig)
              );
            }
          });

          prefilledResultKeysRef.current = prefilled;

          setResults(recalculateDerivedResults(initialResults, undefined, initialManualOverrides));
          setDerivedManualOverrides(initialManualOverrides);
          setSignerNameByResultKey(initialSignerNames);

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

  // Recalculate derived results after visit data populates sortedDerivedTests
  useEffect(() => {
    if (!visit || sortedDerivedTests.length === 0) return;
    setResults((prev) =>
      recalculateDerivedResults(prev, undefined, derivedManualOverrides)
    );
  }, [visit, sortedDerivedTests.length]);

  // Fetch active signing rules so the per-narrative "Doctor's Name" input
  // can lock for departments where a rule is the source of truth. One light
  // query — rules are small and rarely change.
  useEffect(() => {
    if (!token || !activeBranchId) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/signing-rules`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        });
        if (!response.ok) return;
        const rules: Array<{ departmentId: string }> = await response.json();
        if (cancelled) return;
        setDepartmentsWithSigningRule(
          new Set(rules.map((r) => r.departmentId).filter(Boolean)),
        );
      } catch (error) {
        console.error('Failed to fetch signing rules:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeBranchId]);

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

  // Build the {testId, value, textValue, flag, ...} payload that the auto-save
  // and explicit save share. Returns null when there is nothing meaningful to
  // send (e.g. external-upload-only visit before the PDF is attached).
  type ResultSaveItem = {
    testOrderId: string;
    testId: string;
    value: number | null;
    textValue: string;
    flag: 'NORMAL' | 'HIGH' | 'LOW' | null;
    notes: null;
    manualOverride: boolean;
    signerNameOverride: string | null;
  };
  type ResultsPayload = { results: ResultSaveItem[] };
  const payloadHasMeaningfulResult = (payload: ResultsPayload): boolean =>
    payload.results.some((result) => {
      if (result.value !== null && result.value !== undefined) return true;
      if (result.textValue.trim()) return true;
      return Boolean(result.signerNameOverride?.trim());
    });

  const buildResultsPayload = useCallback((isExplicit = false): ResultsPayload | null => {
    if (!visit || !visitId) return null;

    type TestForSave = {
      resultKey: ResultKey;
      testOrderId: string;
      testId: string;
      testName: string;
      testCode: string;
      referenceRange: ReferenceRange;
      min: number;
      max: number;
      isDerived: boolean;
    };
    const allTests: TestForSave[] = [];
    visit.testOrders.forEach((order) => {
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return;
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        order.childTests.forEach((child) => {
          allTests.push({
            resultKey: makeResultKey(order.id, child.id),
            testOrderId: order.id,
            testId: child.id,
            testName: child.name,
            testCode: child.code,
            referenceRange: child.referenceRange,
            min: child.referenceRange.min,
            max: child.referenceRange.max,
            isDerived: !!child.isDerived,
          });
        });
      } else {
        allTests.push({
          resultKey: makeResultKey(order.id, order.testId),
          testOrderId: order.id,
          testId: order.testId,
          testName: order.testName,
          testCode: order.testCode,
          referenceRange: order.referenceRange,
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

    const resultsArray: ResultSaveItem[] = allTests
      .filter((test) => {
        const signerSet = Boolean(signerNameByResultKey[test.resultKey]?.trim());
        const touchedForSave = touchedForSaveResultKeysRef.current.has(test.resultKey);
        const isPrefilled = prefilledResultKeysRef.current.has(test.resultKey);
        const valueReady =
          hasResultValue(results[test.resultKey], textLayoutByResultKey.get(test.resultKey)) &&
          (isExplicit || !isPrefilled);
        // Include if either: the value is real (not just a prefill) OR the
        // radiologist typed a doctor name override OR the user cleared a field.
        // Touched blank rows intentionally delete stale draft values server-side.
        return valueReady || signerSet || touchedForSave;
      })
      .map((test) => {
        const layoutType = textLayoutByResultKey.get(test.resultKey);
        const isPrefilled = !isExplicit && prefilledResultKeysRef.current.has(test.resultKey);
        const rawValue = results[test.resultKey] ?? '';
        const valueStr = isRichTextPanelLayout(layoutType)
          ? normalizeNarrativeContent(rawValue)
          : rawValue;
        const effectiveInputConfig = getEffectiveInputConfig(
          testInputConfigByResultKey.get(test.resultKey) ?? DEFAULT_INPUT_CONFIG,
          test.testName,
          test.testCode,
          test.referenceRange
        );
        const forceTextValue =
          textLayoutByResultKey.has(test.resultKey) ||
          effectiveInputConfig.inputType !== 'NUMERIC';
        const parsedValue = parseFloat(valueStr);
        const isNumeric =
          !forceTextValue && !isNaN(parsedValue) && valueStr.trim() !== '' && !isPrefilled;
        const flag = isNumeric ? flagFor(parsedValue, test.min, test.max) : null;
        // Don't ship a prefill value back to the server — it would silently
        // overwrite edits made elsewhere. Signer-only rows go through with
        // value/textValue cleared.
        const safeValue = isPrefilled ? null : (isNumeric ? parsedValue : null);
        const safeTextValue = isPrefilled ? '' : valueStr;
        return {
          testOrderId: test.testOrderId,
          testId: test.testId,
          value: safeValue,
          textValue: safeTextValue,
          flag: isNumeric ? (flag || 'NORMAL') : null,
          notes: null,
          manualOverride: test.isDerived ? !!derivedManualOverrides[test.resultKey] : false,
          signerNameOverride: signerNameByResultKey[test.resultKey]?.trim() || null,
        };
      });

    if (resultsArray.length === 0) return null;
    return { results: resultsArray };
  }, [visit, visitId, results, derivedManualOverrides, textLayoutByResultKey, signerNameByResultKey, testInputConfigByResultKey]);

  const persistDraft = useCallback(async (isExplicit = false): Promise<'saved' | 'empty' | 'failed'> => {
    if (!visitId) return 'empty';
    const payload = buildResultsPayload(isExplicit);
    if (!payload) return 'empty';

    try {
      const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/results`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      return response.ok ? 'saved' : 'failed';
    } catch (error) {
      console.error('persistDraft failed:', error);
      return 'failed';
    }
  }, [visitId, buildResultsPayload, token, activeBranchId]);

  // Drive the inline status indicator. Coordinates in-flight saves so we don't
  // race two POSTs. When a save is requested while another is already running,
  // we flip pendingResaveRef and re-fire once the current one resolves — that
  // way edits made *during* a slow save are never silently dropped and the
  // status indicator never lies "Saved" when newer edits are still local-only.
  const runAutoSave = useCallback(async () => {
    if (inFlightSaveRef.current) {
      pendingResaveRef.current = true;
      return;
    }
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
      if (pendingResaveRef.current) {
        pendingResaveRef.current = false;
        // Newer edits arrived during the save we just finished. Fire one
        // follow-up POST so the server catches up to local state.
        void runAutoSave();
      }
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

    // Auto-save only persists non-EXTERNAL_UPLOAD result rows (persistDraft
    // filters those out before POSTing). So a missing PDF on an external-upload
    // order MUST NOT block auto-save of the rest of the visit — that would
    // silently drop the staff's lab values in mixed visits. The save button's
    // disabled state still handles the finalize-gating separately.
    const hasAnyManualValueShape = visit.testOrders.some((order) => {
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return false;
      if (!order.isPanel) return true;
      return order.childTests.length > 0;
    });
    if (!hasAnyManualValueShape) return;

    dirtyRef.current = true;
    setAutoSaveStatus('unsaved');

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void runAutoSave();
    }, 1500);
  }, [results, derivedManualOverrides, signerNameByResultKey, loading, visit, uploadsByOrder, runAutoSave]);

  // Refs to grab the latest closures from event handlers that bind once
  // (unmount cleanup, beforeunload listener). Without refs we'd read stale
  // results state on tab close and lose the most recent edits.
  const runAutoSaveRef = useRef(runAutoSave);
  useEffect(() => { runAutoSaveRef.current = runAutoSave; }, [runAutoSave]);
  const buildResultsPayloadRef = useRef(buildResultsPayload);
  useEffect(() => { buildResultsPayloadRef.current = buildResultsPayload; }, [buildResultsPayload]);

  // On unmount (route change inside the SPA), flush the pending debounced
  // save. The fetch fires and completes in the background even after the
  // component unmounts.
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
        if (dirtyRef.current) {
          void runAutoSaveRef.current();
        }
      }
    };
  }, []);

  // On full page unload (tab close, refresh, navigate away), flush via
  // `fetch({ keepalive: true })`. Browsers guarantee keepalive requests
  // survive the navigation up to a small body-size limit (~64 KB, plenty
  // for a results POST). sendBeacon isn't usable here because it can't
  // carry the Authorization header.
  useEffect(() => {
    if (!visitId) return;
    const handler = () => {
      if (!dirtyRef.current) return;
      const payload = buildResultsPayloadRef.current();
      if (!payload) return;
      try {
        fetch(`${API_BASE}/visits/diagnostic/${visitId}/results`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId || '',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch (err) {
        // best-effort — don't block navigation
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [visitId, token, activeBranchId]);

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

  useEffect(() => {
    if (!loading && visit) {
      // Focus the first empty input field so staff can resume data entry where they left off.
      // If all fields are filled, it falls back to focusing the very first field.
      setTimeout(() => {
        const elements = Array.from(
          document.querySelectorAll('.test-value-input:not([disabled]):not([readonly])')
        ) as HTMLElement[];

        let target = elements.find((el) => {
          if (el instanceof HTMLInputElement) {
            return !el.value || el.value.trim() === '';
          }
          // For TestValueCombobox (which is a button), we store the value in the title attribute
          return !el.title || el.title.trim() === '';
        });

        if (!target && elements.length > 0) {
          target = elements[0];
        }

        if (target) {
          target.focus();
        }
      }, 100);
    }
  }, [loading, visit]);

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
  const activeTestOrders = testOrders.filter((o) => !o.noReportAt);
  const waivedOrders = testOrders.filter((o) => o.noReportAt);
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

  const handleValueChange = (resultKey: ResultKey, value: string) => {
    touchedForSaveResultKeysRef.current.add(resultKey);
    // Any user-initiated change promotes the value from "prefill" to a real
    // edit. Once cleared, auto-save will start including this testId in its
    // POST. Until cleared, the prefilled value stays local-only.
    if (prefilledResultKeysRef.current.has(resultKey)) {
      prefilledResultKeysRef.current.delete(resultKey);
    }
    setResults((prev) => {
      const updated = { ...prev, [resultKey]: value };
      const changedCode = resultKeyToCodeMap.get(resultKey);
      return changedCode
        ? recalculateDerivedResults(updated, changedCode)
        : updated;
    });
  };

  const handleSignerNameChange = (resultKey: ResultKey, value: string) => {
    touchedForSaveResultKeysRef.current.add(resultKey);
    setSignerNameByResultKey((prev) => ({ ...prev, [resultKey]: value }));
  };

  const togglePanel = (orderId: string) => {
    setExpandedPanels((prev) => ({
      ...prev,
      [orderId]: !prev[orderId],
    }));
  };

  const getAllTestsForValidation = (): Array<{ resultKey: ResultKey; code: string; min: number; max: number; isDerived: boolean }> => {
    const allTests: Array<{ resultKey: ResultKey; code: string; min: number; max: number; isDerived: boolean }> = [];

    testOrders.forEach((order) => {
      // EXTERNAL_UPLOAD orders carry their result as a PDF — never as values.
      if (order.workflowMode === 'EXTERNAL_UPLOAD') return;
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        order.childTests.forEach((child) => {
          allTests.push({
            resultKey: makeResultKey(order.id, child.id),
            code: child.code,
            min: child.referenceRange.min,
            max: child.referenceRange.max,
            isDerived: !!child.isDerived,
          });
        });
      } else {
        allTests.push({
          resultKey: makeResultKey(order.id, order.testId),
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
      if (textLayoutByResultKey.has(test.resultKey)) {
        return;
      }

      const valueStr = results[test.resultKey];
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
      const payload = buildResultsPayload(true);
      const hasMeaningfulPayload = payload ? payloadHasMeaningfulResult(payload) : false;
      const result = await persistDraft(true);
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
        if (!hasMeaningfulPayload && !hasAnyExternalUpload) {
          toast.error('Please enter at least one test result');
          return;
        }
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

  const handleDerivedModeToggle = (resultKey: ResultKey, makeManual: boolean) => {
    setDerivedManualOverrides((prev) => {
      if (makeManual) {
        return {
          ...prev,
          [resultKey]: true,
        };
      }

      const next = { ...prev };
      delete next[resultKey];
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
                      className="text-xs font-medium text-destructive hover:underline"
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
    testOrderId: string,
    testId: string,
    testName: string,
    testCode: string,
    referenceRange: ReferenceRange,
    isSubTest: boolean = false,
    isDerived: boolean = false
  ) => {
    const resultKey = makeResultKey(testOrderId, testId);
    const valueStr = results[resultKey] || '';
    const value = valueStr ? parseFloat(valueStr) : null;
    const flag = value !== null
      ? computeFlag(value, referenceRange.min, referenceRange.max)
      : null;
    const isManualDerived = isDerived && !!derivedManualOverrides[resultKey];
    const isAutoDerived = isDerived && !isManualDerived;

    const hasNumericRange = referenceRange.min > 0 || referenceRange.max > 0;
    const displayRefText = referenceRange.text || (hasNumericRange
      ? `${referenceRange.min || ''} – ${referenceRange.max || ''} ${referenceRange.unit}`
      : 'NIL');
    // When no explicit config exists, infer the input type from the reference
    // range: a text-only reference (e.g. "YELLOW/PALE YELLOW") means the
    // value is text, not a number. Without this, mobile defaults to the
    // numeric keyboard and the user can't type letters.
    const storedInputConfig = testInputConfigByResultKey.get(resultKey);
    const inputConfig = getEffectiveInputConfig(
      storedInputConfig ?? (hasNumericRange
        ? DEFAULT_INPUT_CONFIG
        : { ...DEFAULT_INPUT_CONFIG, inputType: 'FREE_TEXT' }),
      testName,
      testCode,
      referenceRange
    );
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
        key={resultKey}
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
                onChange={(next) => handleValueChange(resultKey, next)}
                options={inputConfig.valueOptions}
                allowCustom={inputConfig.inputType === 'TEXT_WITH_PRESETS'}
                placeholder="Select value…"
                disabled={isAutoDerived}
              />
            ) : (
              <Input
                type="text"
                inputMode={inputConfig.inputType === 'NUMERIC' && !displayRefText.includes('-') && !displayRefText.includes('–') ? 'decimal' : 'text'}
                placeholder={isAutoDerived ? 'Auto-calculated' : 'Value'}
                value={valueStr}
                onChange={(e) => handleValueChange(resultKey, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const form = e.currentTarget.closest('form') || document;
                    const inputs = Array.from(
                      form.querySelectorAll('.test-value-input:not([disabled]):not([readonly])')
                    ) as HTMLElement[];
                    const index = inputs.indexOf(e.currentTarget);
                    if (index > -1 && index < inputs.length - 1) {
                      inputs[index + 1].focus();
                    }
                  }
                }}
                readOnly={isAutoDerived}
                disabled={isAutoDerived}
                className={cn(
                  'text-center test-value-input',
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
                onClick={() => handleDerivedModeToggle(resultKey, !isManualDerived)}
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
    testOrderId: string,
    testId: string,
    testName: string,
    testCode: string,
    placeholder: string,
    _isSubTest: boolean = false,
    panelDisplayName?: string,
    departmentName?: string,
    departmentId?: string,
  ) => {
    const resultKey = makeResultKey(testOrderId, testId);
    const valueStr = results[resultKey] || '';
    const locked = departmentId
      ? departmentsWithSigningRule.has(departmentId)
      : false;
    const lockedReason = locked
      ? `A signing rule is configured for ${departmentName || 'this department'}. Remove the rule in Settings → Signing Doctors to enter a name here.`
      : undefined;
    const order = testOrders.find((o) => o.id === testOrderId);
    const isWholeOrderRow = !!order && order.testId === testId;

    return (
      <div key={resultKey} className="py-3">
        {isWholeOrderRow && (
          <div className="flex justify-end mb-1">
            <button
              type="button"
              onClick={() => { setNoReportReasonText(''); setNoReportTarget({ orderId: testOrderId, testName: panelDisplayName || testName }); }}
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              No report needed
            </button>
          </div>
        )}
        <ReportFramedNarrativeEditor
          value={valueStr}
          onChange={(nextValue) => handleValueChange(resultKey, nextValue)}
          patient={{
            name: visit?.patient.name || '',
            title: visit?.patient.title || null,
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
          signerName={signerNameByResultKey[resultKey] || ''}
          onSignerNameChange={(next) => handleSignerNameChange(resultKey, next)}
          signerLocked={locked}
          signerLockedReason={lockedReason}
          onFirstTouch={() => markNarrativeTouched(resultKey)}
        />
      </div>
    );
  };

  const countFilledResults = (order: TestOrder): number => {
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.filter((child) =>
        hasResultValue(
          results[makeResultKey(order.id, child.id)],
          textLayoutByResultKey.get(makeResultKey(order.id, child.id))
        )
      ).length;
    }
    const resultKey = makeResultKey(order.id, order.testId);
    return hasResultValue(results[resultKey], textLayoutByResultKey.get(resultKey)) ? 1 : 0;
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
    productName?: string;
    orders: TestOrder[];
  };
  type SingleOrder = {
    type: 'single';
    order: TestOrder;
  };
  type OrderGroup = PanelGroup | SingleOrder;

  const departmentGroups = Array.from(
    activeTestOrders.reduce((groups, order) => {
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
        // Scope the panel grouping to the specific productId so identical panels from different products don't merge
        const panelGroupKey = `${order.productId || 'no-product'}_${order.panel.id}`;
        if (!panelGroups.has(panelGroupKey)) {
          panelGroups.set(panelGroupKey, {
            type: 'panel',
            panelId: order.panel.id,
            panelName: order.panel.name,
            panelDisplayName: order.panel.displayName,
            panelLayoutType: order.panel.layoutType,
            panelMethodText: order.panel.panelMethodText || null,
            panelMethodItalic: order.panel.panelMethodItalic || false,
            productName: order.product?.name,
            orders: [],
          });
        }
        panelGroups.get(panelGroupKey)!.orders.push(order);
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
  const hasReportableInputs = activeTestOrders.some((order) => {
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

    const resultKeys: string[] =
      order.isPanel && order.childTests && order.childTests.length > 0
        ? order.childTests.map((c) => makeResultKey(order.id, c.id))
        : [makeResultKey(order.id, order.testId)];

    let sawContent = false;
    let allTemplateOnly = true;
    let anyNarrative = false;

    for (const resultKey of resultKeys) {
      const layout = textLayoutByResultKey.get(resultKey);
      const value = results[resultKey];
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
        // A narrative counts as `complete` only when its saved content
        // *differs* from the panel's template (i.e. a real edit landed —
        // possibly in a prior session). Clicking the editor without typing
        // anything is NOT enough to promote the status — clicks can be
        // accidental, so the radiologist must always confirm via the
        // partial-release dialog before a touched-but-unedited narrative
        // ships. The touch signal is used elsewhere to drive the dialog
        // pre-tick (so the user can confirm or untick), not status.
        const template = narrativeTemplateByResultKey.get(resultKey);
        const templatePlain = template ? richTextToPlainText(template).trim() : '';
        const valuePlain = richTextToPlainText(value).trim();
        // Narrative counts as complete when:
        //   • there's no template to compare against (panel has no
        //     authored boilerplate — any saved content is a real edit), or
        //   • the saved text differs from the template's plain text.
        const htmlDiffersFromTemplate =
          templatePlain.length === 0 || valuePlain !== templatePlain;
        if (htmlDiffersFromTemplate) {
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
    activeTestOrders.map((o) => [o.id, computeOrderStatus(o)] as const),
  );
  // Visit is "fully done" when every reportable order is `complete` — no
  // template-only narratives, no empty slots, no missing external uploads.
  const fullyDone =
    !hasMissingExternalUploads &&
    activeTestOrders.length > 0 &&
    activeTestOrders.every((o) => orderStatuses.get(o.id) === 'complete');
  // Orders that could appear in a partial release. Empty orders are excluded
  // entirely (nothing to ship). Template-only narratives are eligible but
  // pre-unchecked. Per-order pre-tick rules live with the dialog data builder
  // below — there's no global "default selection" set anymore because the
  // narrative path now defers to the per-editor touched signal.
  const partialEligibleOrderIds = activeTestOrders
    .filter((o) => orderStatuses.get(o.id) !== 'empty')
    .map((o) => o.id);

  // True if any test in this visit uses the WYSIWYG framed narrative editor.
  // Used to decide whether to show the sticky shared rich-text toolbar at the
  // top of the page.
  const hasNarrativeTests = activeTestOrders.some((order) => {
    if (isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(order.id, order.testId)))) return true;
    if (order.isPanel && order.childTests) {
      return order.childTests.some((child) =>
        isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(order.id, child.id)))
      );
    }
    return false;
  });

  // True if any test in this visit needs the structured Test/Value/Range/Flag
  // column header. Narrative tests don't, so the header is hidden when every
  // test is narrative — it would just confuse the user (radiology has no
  // numeric "value" or "reference range").
  const hasNonNarrativeTests = activeTestOrders.some((order) => {
    if (order.workflowMode === 'EXTERNAL_UPLOAD') return false;
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.some(
        (child) => !isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(order.id, child.id)))
      );
    }
    return !isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(order.id, order.testId)));
  });

  const submitNoReport = async () => {
    if (!noReportTarget || !visitId) return;
    const reason = noReportReasonText.trim();
    if (!reason) { toast.error('Please enter a reason.'); return; }
    setNoReportBusy(true);
    try {
      const res = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/orders/${noReportTarget.orderId}/no-report`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'X-Branch-Id': activeBranchId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.message || 'Could not close this test.'); return; }
      setVisit((prev) => prev ? { ...prev, testOrders: prev.testOrders.map((o) => o.id === noReportTarget.orderId ? { ...o, noReportAt: data?.noReportAt || new Date().toISOString(), noReportReason: reason } : o) } : prev);
      toast.success('Test closed — no report will be issued.');
      setNoReportTarget(null);
      setNoReportReasonText('');
    } catch (e) {
      console.error('no-report failed:', e);
      toast.error('Could not close this test.');
    } finally {
      setNoReportBusy(false);
    }
  };

  const reopenNoReport = async (orderId: string) => {
    if (!visitId) return;
    try {
      const res = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/orders/${orderId}/reopen-report`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'X-Branch-Id': activeBranchId, 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.message || 'Could not reopen this test.'); return; }
      setVisit((prev) => prev ? { ...prev, testOrders: prev.testOrders.map((o) => o.id === orderId ? { ...o, noReportAt: null, noReportReason: null, noReportBy: null } : o) } : prev);
      toast.success('Test reopened for result entry.');
    } catch (e) {
      console.error('reopen failed:', e);
      toast.error('Could not reopen this test.');
    }
  };

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
                <h2 className="text-xl font-bold">{formatPatientName(patient.name, (patient as any).title)}</h2>
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
            {waivedOrders.length > 0 && (
              <div className="space-y-2">
                {waivedOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-2.5">
                    <div className="text-sm">
                      <span className="font-medium">{o.testName}</span>
                      {o.testCode ? <span className="ml-1 text-muted-foreground">({o.testCode})</span> : null}
                      <div className="text-xs text-muted-foreground mt-0.5">
                        No written report{o.noReportReason ? ` — ${o.noReportReason}` : ''}{o.noReportBy ? ` · ${o.noReportBy}` : ''}
                      </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => reopenNoReport(o.id)}>Reopen</Button>
                  </div>
                ))}
              </div>
            )}
            {!hasReportableInputs ? (
              waivedOrders.length > 0 ? null : (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No reportable test items are linked to this visit yet. Add the required backing test item to the panel definition, then reopen this visit.
              </div>
              )
            ) : (
              <>
                {departmentGroups.map((department) => (
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
                            isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(o.id, o.testId)))
                          )
                        : (() => {
                            const o = group.order;
                            if (o.workflowMode === 'EXTERNAL_UPLOAD') return false;
                            if (o.isPanel && o.childTests && o.childTests.length > 0) {
                              return o.childTests.every((c) =>
                                isRichTextPanelLayout(textLayoutByResultKey.get(makeResultKey(o.id, c.id)))
                              );
                            }
                            return isRichTextPanelLayout(
                              textLayoutByResultKey.get(makeResultKey(o.id, o.testId))
                            );
                          })();

                    if (isNarrativeOnlyGroup) {
                      if (group.type === 'panel') {
                        return (
                          <div key={group.panelId} className="space-y-4">
                            {group.orders.map((order) => {
                              const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, order.testId));
                              return renderNarrativeInput(
                                order.id,
                                order.testId,
                                order.testName,
                                order.testCode,
                                textLayout === 'IMAGING_NARRATIVE'
                                  ? 'Enter narrative report...'
                                  : 'Enter text result...',
                                false,
                                group.panelDisplayName || group.panelName,
                                department.name,
                                department.id,
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
                              const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, child.id));
                              return renderNarrativeInput(
                                order.id,
                                child.id,
                                child.name,
                                child.code,
                                textLayout === 'IMAGING_NARRATIVE'
                                  ? 'Enter narrative report...'
                                  : 'Enter text result...',
                                false,
                                order.panel?.displayName || order.panel?.name || order.testName,
                                department.name,
                                department.id,
                              );
                            })}
                          </div>
                        );
                      }

                      const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, order.testId));
                      return (
                        <div key={order.id}>
                          {renderNarrativeInput(
                            order.id,
                            order.testId,
                            order.testName,
                            order.testCode,
                            textLayout === 'IMAGING_NARRATIVE'
                              ? 'Enter narrative report...'
                              : 'Enter text result...',
                            false,
                            order.panel?.displayName || order.panel?.name || order.testName,
                            department.name,
                            department.id,
                          )}
                        </div>
                      );
                    }

                    // Render grouped panel (multiple orders with same panel.id)
                    if (group.type === 'panel') {
                      const panelGroup = group;
                      const isExpanded = expandedPanels[panelGroup.panelId] ?? true;
                      const filled = panelGroup.orders.filter((o) =>
                        hasResultValue(
                          results[makeResultKey(o.id, o.testId)],
                          textLayoutByResultKey.get(makeResultKey(o.id, o.testId))
                        )
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
                                <div className="flex items-center gap-3">
                                  <span className="text-lg font-semibold">{panelGroup.panelDisplayName || panelGroup.panelName}</span>
                                  {panelGroup.productName && panelGroup.productName !== (panelGroup.panelDisplayName || panelGroup.panelName) && (
                                    <span className="text-sm font-medium text-muted-foreground border-l border-border pl-3">
                                      (Billed as: {panelGroup.productName})
                                    </span>
                                  )}
                                </div>
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
                                const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, order.testId));
                                if (isRichTextPanelLayout(textLayout)) {
                                  return renderNarrativeInput(
                                    order.id,
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    textLayout === 'IMAGING_NARRATIVE'
                                      ? 'Enter narrative report...'
                                      : 'Enter text result...',
                                    true,
                                    undefined,
                                    department.name,
                                    department.id,
                                  );
                                }

                                return renderTestInput(
                                  order.id,
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
                                  const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, child.id));
                                  if (isRichTextPanelLayout(textLayout)) {
                                    return renderNarrativeInput(
                                      order.id,
                                      child.id,
                                      child.name,
                                      child.code,
                                      textLayout === 'IMAGING_NARRATIVE'
                                        ? 'Enter narrative report...'
                                        : 'Enter text result...',
                                      true,
                                      undefined,
                                      department.name,
                                      department.id,
                                    );
                                  }

                                  return renderTestInput(
                                    order.id,
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
                                const textLayout = textLayoutByResultKey.get(makeResultKey(order.id, order.testId));
                                if (isRichTextPanelLayout(textLayout)) {
                                  return renderNarrativeInput(
                                    order.id,
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    textLayout === 'IMAGING_NARRATIVE'
                                      ? 'Enter narrative report...'
                                      : 'Enter text result...',
                                    false,
                                    undefined,
                                    department.name,
                                    department.id,
                                  );
                                }

                                return renderTestInput(
                                  order.id,
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
              </>
            )}

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
                ? (canFinalize ? 'Review & Finalize' : 'Review Report')
                : 'Continue with Partial Report';

              // Narrative AND external-upload tests both look "complete" the
              // moment the doctor adds content / a file, even when they're
              // still drafting (typed a paragraph, uploaded one of three
              // expected PDFs, etc.). Always route via the partial-release
              // dialog when either is present so the doctor explicitly
              // confirms what ships — Cancel safely backs out (auto-save
              // and uploaded files are preserved).
              const hasExternalUploadTests = testOrders.some(
                (o) => o.workflowMode === 'EXTERNAL_UPLOAD',
              );
              const requiresExplicitConfirmation =
                hasNarrativeTests || hasExternalUploadTests;

              const handleClick = () => {
                if (fullyDone && !requiresExplicitConfirmation) {
                  // Pure numeric visit — reuse the extreme-value validation
                  // flow so we don't bypass the warning dialog for fully-
                  // done visits.
                  handleSaveDraft();
                  return;
                }
                if (
                  partialEligibleOrderIds.length <= 1 &&
                  !requiresExplicitConfirmation
                ) {
                  // Zero or one eligible non-narrative / non-upload order
                  // — no choice to make in a dialog. Route through the
                  // standard save path with NO partialSelection; the
                  // preview page then decides between /finalize and
                  // /release-partial based on whether other reportable
                  // orders in the visit are still pending.
                  void saveResults(undefined);
                  return;
                }
                // Multiple orders eligible, or any narrative / upload
                // present — open the selector dialog so the doctor confirms.
                setPartialDialogOpen(true);
              };

              return (
                <>
                  {renderAutoSaveStatus(autoSaveStatus, lastSavedAt)}
                  <Button
                    className="w-full mt-2"
                    size="lg"
                    onClick={handleClick}
                    disabled={saving || !hasReportableInputs}
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
          template-only narratives that look "ready" by row presence alone.
          Rows are collapsed by panel so a panel with N constituent test
          orders shows as a single line, not N near-identical duplicates. */}
      {(() => {
        // Aggregate test orders into panel-level rows. Each row represents
        // one panel (or one standalone test if not part of a panel); when
        // a panel was ordered as multiple sub-orders they collapse here.
        type PanelAgg = {
          rowId: string;
          departmentName: string;
          label: string;
          orderIds: string[];
          statuses: TestOrderStatus[];
          disabledFlags: boolean[];
          uploadCounts: number[];
          paramFilled: number;
          paramTotal: number;
          isNarrative: boolean;
          narrativeTouched: boolean;
          workflowMode?: TestOrder['workflowMode'];
        };
        const panelMap = new Map<string, PanelAgg>();

        testOrders.forEach((order) => {
          const status = orderStatuses.get(order.id);
          const isMissingUpload =
            order.workflowMode === 'EXTERNAL_UPLOAD' &&
            (uploadsByOrder[order.id]?.length ?? 0) === 0;
          if (status === 'empty' && !isMissingUpload) return;

          const deptName = order.department?.name || 'Tests';
          const panelKey = order.panel?.id
            ? `panel:${order.panel.id}`
            : `order:${order.id}`;
          const rowId = `${deptName}::${panelKey}`;

          if (!panelMap.has(rowId)) {
            panelMap.set(rowId, {
              rowId,
              departmentName: deptName,
              label:
                order.panel?.displayName ||
                order.panel?.name ||
                order.testName,
              orderIds: [],
              statuses: [],
              disabledFlags: [],
              uploadCounts: [],
              paramFilled: 0,
              paramTotal: 0,
              isNarrative: false,
              narrativeTouched: false,
              workflowMode: order.workflowMode,
            });
          }
          const agg = panelMap.get(rowId)!;
          agg.orderIds.push(order.id);
          if (status) agg.statuses.push(status);

          let rowDisabled = false;
          if (order.workflowMode === 'EXTERNAL_UPLOAD') {
            const count = uploadsByOrder[order.id]?.length ?? 0;
            agg.uploadCounts.push(count);
            if (count === 0) rowDisabled = true;
          }
          agg.disabledFlags.push(rowDisabled);

          const resultKeys =
            order.isPanel && order.childTests && order.childTests.length > 0
              ? order.childTests.map((c) => makeResultKey(order.id, c.id))
              : [makeResultKey(order.id, order.testId)];
          agg.paramTotal += resultKeys.length;
          agg.paramFilled += resultKeys.filter((resultKey) =>
            hasResultValue(results[resultKey], textLayoutByResultKey.get(resultKey)),
          ).length;

          const narrativeKeys = resultKeys.filter((resultKey) =>
            isRichTextPanelLayout(textLayoutByResultKey.get(resultKey)),
          );
          if (narrativeKeys.length > 0) agg.isNarrative = true;
          if (narrativeKeys.some((resultKey) => touchedNarrativeResultKeys.has(resultKey))) {
            agg.narrativeTouched = true;
          }
        });

        const groupMap = new Map<string, PartialReleaseGroup>();
        const rowToOrderIds = new Map<string, string[]>();

        panelMap.forEach((agg) => {
          if (!groupMap.has(agg.departmentName)) {
            groupMap.set(agg.departmentName, {
              departmentName: agg.departmentName,
              orders: [],
            });
          }

          const allDisabled =
            agg.disabledFlags.length > 0 &&
            agg.disabledFlags.every(Boolean);
          const allComplete =
            agg.statuses.length > 0 &&
            agg.statuses.every((s) => s === 'complete');
          const anyTemplateOnly = agg.statuses.some(
            (s) => s === 'template-only',
          );

          let hint: string | undefined;
          let hintVariant: 'normal' | 'warning' | undefined;
          let sublabel: string | undefined;

          if (agg.workflowMode === 'EXTERNAL_UPLOAD') {
            const totalUploads = agg.uploadCounts.reduce((a, b) => a + b, 0);
            const missingCount = agg.uploadCounts.filter((c) => c === 0).length;
            if (allDisabled) {
              hint = 'No PDF uploaded — cannot ship';
              hintVariant = 'warning';
            } else if (missingCount > 0) {
              hint = `${missingCount} of ${agg.uploadCounts.length} missing PDF`;
              hintVariant = 'warning';
            } else {
              hint = `${totalUploads} file${totalUploads === 1 ? '' : 's'} uploaded`;
            }
          } else if (anyTemplateOnly && !allComplete) {
            hint = 'Template only — not edited yet';
            hintVariant = 'warning';
          } else if (agg.paramTotal === 1 && !agg.isNarrative) {
            // Single-parameter standalone test — surface the value inline.
            const onlyOrderId = agg.orderIds[0];
            const order = testOrders.find((o) => o.id === onlyOrderId);
            const onlyTestId = order?.testId;
            const v = onlyTestId && onlyOrderId
              ? results[makeResultKey(onlyOrderId, onlyTestId)]
              : undefined;
            if (v) sublabel = `value: ${v}`;
          } else if (agg.paramTotal > 0) {
            hint = `${agg.paramFilled} of ${agg.paramTotal} parameter${agg.paramTotal === 1 ? '' : 's'} entered`;
          }

          const defaultChecked = allDisabled
            ? false
            : agg.isNarrative
            ? agg.narrativeTouched || allComplete
            : allComplete;

          groupMap.get(agg.departmentName)!.orders.push({
            id: agg.rowId,
            label: agg.label,
            sublabel,
            hint,
            hintVariant,
            defaultChecked,
            disabled: allDisabled,
          });
          rowToOrderIds.set(agg.rowId, agg.orderIds);
        });

        return (
          <PartialReleaseSelectorDialog
            open={partialDialogOpen}
            onOpenChange={setPartialDialogOpen}
            groups={Array.from(groupMap.values())}
            busy={saving}
            onConfirm={(selectedRowIds) => {
              setPartialDialogOpen(false);
              // Expand selected panel-row IDs back to the underlying test
              // order IDs the backend expects.
              const expanded = selectedRowIds.flatMap(
                (rowId) => rowToOrderIds.get(rowId) ?? [],
              );
              // If every eligible order is selected, treat as a full
              // finalize (skip partialSelection so the preview/finalize
              // path takes over — see comment on saveResults).
              const selectedSet = new Set(expanded);
              const isFullSelection =
                expanded.length === partialEligibleOrderIds.length &&
                partialEligibleOrderIds.every((id) => selectedSet.has(id));
              void saveResults(isFullSelection ? undefined : expanded);
            }}
          />
        );
      })()}

      {/* No Report (films only) confirmation */}
      <AlertDialog open={!!noReportTarget} onOpenChange={(open) => { if (!open) { setNoReportTarget(null); setNoReportReasonText(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close this test without a report?</AlertDialogTitle>
            <AlertDialogDescription>
              {noReportTarget?.testName} will be finalized as films only — no written report and no report message to the patient. The rest of the bill is unaffected. You can reopen it until the report is finalized.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-1">
            <label className="text-sm font-medium">Reason</label>
            <Input
              autoFocus
              value={noReportReasonText}
              onChange={(e) => setNoReportReasonText(e.target.value)}
              placeholder="Films sufficient / patient declined report"
              className="mt-1.5"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={noReportBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={noReportBusy || !noReportReasonText.trim()}
              onClick={(e) => { e.preventDefault(); submitNoReport(); }}
            >
              {noReportBusy ? 'Closing…' : 'Close, no report'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            <AlertDialogCancel disabled={saving}>Go Back & Edit</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave} disabled={saving}>
              {saving ? 'Saving...' : 'Acknowledge & Save'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default DiagnosticsResultEntry;

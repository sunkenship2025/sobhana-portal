import { useState, useEffect, useMemo, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { RichTextNarrativeEditor } from '@/components/diagnostics/RichTextNarrativeEditor';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { FlagBadge } from '@/components/ui/flag-badge';
import { toast } from 'sonner';
import { AlertTriangle, Save, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
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

interface ChildTest {
  id: string;
  name: string;
  code: string;
  displayOrder: number;
  isDerived?: boolean;
  formulaExpression?: string | null;
  dependsOnCodes?: string[] | null;
  referenceRange: ReferenceRange;
}

interface TestOrder {
  id: string;
  testId: string;
  testDefinitionId?: string;
  testName: string;
  testCode: string;
  price: number;
  isPanel: boolean;
  isDerived?: boolean;
  formulaExpression?: string | null;
  dependsOnCodes?: string[] | null;
  referenceRange: ReferenceRange;
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

interface Visit {
  id: string;
  billNumber: string;
  status: string;
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
      status: string;
      testResults?: Array<{
        testId: string;
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
const TEXT_LAYOUT_ROWS: Record<string, number> = {
  TEXT_ONLY: 4,
};

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

  if (layoutType === 'IMAGING_NARRATIVE') {
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
                if (layoutType === 'IMAGING_NARRATIVE') {
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
                  layoutType === 'IMAGING_NARRATIVE'
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

  const saveResults = async () => {
    setSaving(true);

    try {
      const allTests = getAllTestsForValidation();
      const resultsArray = allTests
        .filter((test) => hasResultValue(results[test.testId], textLayoutByTestId.get(test.testId)))
        .map((test) => {
          const layoutType = textLayoutByTestId.get(test.testId);
          const rawValue = results[test.testId];
          const valueStr = layoutType === 'IMAGING_NARRATIVE'
            ? normalizeNarrativeContent(rawValue)
            : rawValue;
          const forceTextValue = textLayoutByTestId.has(test.testId);
          const parsedValue = parseFloat(valueStr);
          const isNumeric = !forceTextValue && !isNaN(parsedValue) && valueStr.trim() !== '';
          const flag = isNumeric ? computeFlag(parsedValue, test.min, test.max) : null;

          return {
            testId: test.testId,
            value: isNumeric ? parsedValue : null,
            textValue: isNumeric ? null : valueStr,
            flag: isNumeric ? (flag || 'NORMAL') : null,
            notes: null,
            manualOverride: test.isDerived ? !!derivedManualOverrides[test.testId] : false,
          };
        });

      if (resultsArray.length === 0) {
        toast.error('Please enter at least one test result');
        setSaving(false);
        return;
      }

      const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/results`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ results: resultsArray })
      });

      if (response.ok) {
        toast.success('Results saved as draft');
        navigate(`/diagnostics/preview/${visitId}`);
      } else {
        const errorData = await response.json();
        toast.error(errorData.message || 'Failed to save results');
      }
    } catch (error) {
      console.error('Failed to save results:', error);
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

        <div className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
            Value
          </span>
          <div className="flex items-center gap-2">
            <Input
              type={hasNumericRange ? 'number' : 'text'}
              step="0.01"
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
      </div>
    );
  };

  const renderTextareaInput = (
    testId: string,
    testName: string,
    testCode: string,
    rows: number,
    placeholder: string,
    isSubTest: boolean = false
  ) => {
    const valueStr = results[testId] || '';

    return (
      <div
        key={testId}
        className={cn(
          'space-y-2 border-b py-3 last:border-0',
          isSubTest ? 'md:pl-4' : ''
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Label className={cn('font-medium', isSubTest ? 'text-sm' : 'text-base')}>
              {testName}
            </Label>
            <span className="text-xs text-muted-foreground">({testCode})</span>
          </div>
        </div>

        <Textarea
          rows={rows}
          placeholder={placeholder}
          value={valueStr}
          onChange={(e) => handleValueChange(testId, e.target.value)}
          className="resize-y"
        />
      </div>
    );
  };

  const renderNarrativeInput = (
    testId: string,
    testName: string,
    testCode: string,
    placeholder: string,
    isSubTest: boolean = false
  ) => {
    const valueStr = results[testId] || '';

    return (
      <div
        key={testId}
        className={cn(
          'space-y-2 border-b py-3 last:border-0',
          isSubTest ? 'md:pl-4' : ''
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Label className={cn('font-medium', isSubTest ? 'text-sm' : 'text-base')}>
              {testName}
            </Label>
            <span className="text-xs text-muted-foreground">({testCode})</span>
          </div>
        </div>

        <RichTextNarrativeEditor
          value={valueStr}
          onChange={(nextValue) => handleValueChange(testId, nextValue)}
          placeholder={placeholder}
          minHeightClassName="min-h-[280px]"
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

  const hasReportableInputs = testOrders.some((order) => {
    if (!order.isPanel) return true;
    return order.childTests.length > 0;
  });

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
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

        {/* Test Results */}
        <Card>
          <CardHeader>
            <CardTitle>Enter Test Results</CardTitle>
            <div className="hidden border-b pb-2 pt-4 text-xs uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[1fr_120px_180px_80px] md:gap-4">
              <div>Test Name</div>
              <div className="text-center">Value</div>
              <div className="text-center">Reference Range</div>
              <div className="text-center">Flag</div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6 pt-0">
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
                                if (textLayout === 'IMAGING_NARRATIVE') {
                                  return renderNarrativeInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    'Enter narrative report...',
                                    true
                                  );
                                }

                                if (textLayout) {
                                  return renderTextareaInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    TEXT_LAYOUT_ROWS[textLayout] || 4,
                                    'Enter text result...',
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
                                  if (textLayout === 'IMAGING_NARRATIVE') {
                                    return renderNarrativeInput(
                                      child.id,
                                      child.name,
                                      child.code,
                                      'Enter narrative report...',
                                      true
                                    );
                                  }

                                  if (textLayout) {
                                    return renderTextareaInput(
                                      child.id,
                                      child.name,
                                      child.code,
                                      TEXT_LAYOUT_ROWS[textLayout] || 4,
                                      'Enter text result...',
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
                              <div className="font-semibold">{order.testName}</div>
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
                                if (textLayout === 'IMAGING_NARRATIVE') {
                                  return renderNarrativeInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    'Enter narrative report...'
                                  );
                                }

                                if (textLayout) {
                                  return renderTextareaInput(
                                    order.testId,
                                    order.testName,
                                    order.testCode,
                                    TEXT_LAYOUT_ROWS[textLayout] || 4,
                                    'Enter text result...'
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

            <Button className="w-full mt-6" size="lg" onClick={handleSaveDraft} disabled={saving || !hasReportableInputs}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {saving ? 'Saving...' : 'Save Draft & Preview Report'}
            </Button>
          </CardContent>
        </Card>
      </div>

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

import { useState, useEffect, useMemo, useCallback } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
        flag: string;
      }>;
    }>;
  };
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
  const [showWarning, setShowWarning] = useState(false);
  const [extremeValues, setExtremeValues] = useState<string[]>([]);
  const [expandedPanels, setExpandedPanels] = useState<Record<string, boolean>>({});

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
      changedCode?: string
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
    [reverseDependencyMap, sortedDerivedTests, testIdToCodeMap]
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
          setVisit(data);

          // Auto-expand all panels
          const panelExpansion: Record<string, boolean> = {};
          data.testOrders.forEach((order: TestOrder) => {
            if (order.isPanel) {
              panelExpansion[order.id] = true;
            }
          });
          setExpandedPanels(panelExpansion);

          // Initialize results from existing test results if any
          if (data.report?.versions?.[0]?.testResults) {
            const initialResults: Record<string, string> = {};
            const latestVersion = data.report.versions[0];
            latestVersion.testResults.forEach((r: any) => {
              if (r.textValue) {
                initialResults[r.testId] = r.textValue;
              } else if (r.value !== null) {
                initialResults[r.testId] = r.value.toString();
              }
            });
            setResults(initialResults);
          }
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

  useEffect(() => {
    if (!visit) return;

    setResults((prev) => {
      const recalculated = recalculateDerivedResults(prev);
      return areResultsEqual(prev, recalculated) ? prev : recalculated;
    });
  }, [visit, recalculateDerivedResults]);

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

  const handleValueChange = useCallback(
    (testId: string, value: string) => {
      setResults((prev) => {
        const updated = { ...prev, [testId]: value };
        const changedCode = testIdToCodeMap.get(testId);
        return changedCode
          ? recalculateDerivedResults(updated, changedCode)
          : updated;
      });
    },
    [recalculateDerivedResults, testIdToCodeMap]
  );

  const togglePanel = (orderId: string) => {
    setExpandedPanels((prev) => ({
      ...prev,
      [orderId]: !prev[orderId],
    }));
  };

  const getAllTestsForValidation = (): Array<{ testId: string; code: string; min: number; max: number }> => {
    const allTests: Array<{ testId: string; code: string; min: number; max: number }> = [];

    testOrders.forEach((order) => {
      if (order.isPanel && order.childTests && order.childTests.length > 0) {
        order.childTests.forEach((child) => {
          allTests.push({
            testId: child.id,
            code: child.code,
            min: child.referenceRange.min,
            max: child.referenceRange.max,
          });
        });
      } else {
        allTests.push({
          testId: order.testId,
          code: order.testCode,
          min: order.referenceRange.min,
          max: order.referenceRange.max,
        });
      }
    });

    return allTests;
  };

  const handleSaveDraft = () => {
    const allTests = getAllTestsForValidation();
    const extreme: string[] = [];

    allTests.forEach((test) => {
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
        .filter((test) => results[test.testId])
        .map((test) => {
          const valueStr = results[test.testId];
          const parsedValue = parseFloat(valueStr);
          const isNumeric = !isNaN(parsedValue) && valueStr.trim() !== '';
          const flag = isNumeric ? computeFlag(parsedValue, test.min, test.max) : null;

          return {
            testId: test.testId,
            value: isNumeric ? parsedValue : null,
            textValue: isNumeric ? null : valueStr,
            flag: flag || 'NORMAL',
            notes: null,
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
          <Label className={cn('font-medium', isSubTest ? 'text-sm' : 'text-base')}>
            {testName}
          </Label>
          <span className="text-xs text-muted-foreground ml-2">({testCode})</span>
          {isDerived && (
            <span className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700">
              Auto
            </span>
          )}
        </div>

        <div className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground md:hidden">
            Value
          </span>
          <Input
            type={hasNumericRange ? 'number' : 'text'}
            step="0.01"
            placeholder={isDerived ? 'Auto-calculated' : 'Value'}
            value={valueStr}
            onChange={(e) => handleValueChange(testId, e.target.value)}
            readOnly={isDerived}
            disabled={isDerived}
            className={cn(
              'text-center',
              isDerived && 'bg-muted cursor-not-allowed text-muted-foreground'
            )}
          />
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

  const countFilledResults = (order: TestOrder): number => {
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.filter((child) => results[child.id]).length;
    }
    return results[order.testId] ? 1 : 0;
  };

  const getTotalTests = (order: TestOrder): number => {
    if (order.isPanel && order.childTests && order.childTests.length > 0) {
      return order.childTests.length;
    }
    return 1;
  };

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
  ).map(([, group]) => group);

  const getPanelTitle = (order: TestOrder) =>
    order.panel?.displayName || order.panel?.name || order.testName;

  const getPanelSubtitle = (order: TestOrder) => {
    const panelTitle = getPanelTitle(order);
    if (panelTitle !== order.testName) {
      return order.testName;
    }
    return null;
  };

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
            {departmentGroups.map((department) => (
              <div key={department.id} className="space-y-3">
                <div className="flex items-center gap-3 pt-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    {department.name}
                  </h3>
                  <div className="flex-1 h-px bg-border" />
                </div>

                <div className="space-y-3">
                  {department.orders.map((order) => {
                    const isPanel = order.isPanel && order.childTests && order.childTests.length > 0;
                    const isExpanded = expandedPanels[order.id] ?? false;
                    const filled = countFilledResults(order);
                    const total = getTotalTests(order);
                    const panelTitle = getPanelTitle(order);
                    const panelSubtitle = getPanelSubtitle(order);

                    return (
                      <div key={order.id} className="overflow-hidden rounded-lg border">
                        {isPanel ? (
                          <>
                            <button
                              onClick={() => togglePanel(order.id)}
                              className="flex w-full flex-col gap-3 bg-muted/50 p-4 text-left transition-colors hover:bg-muted/70 sm:flex-row sm:items-center sm:justify-between"
                            >
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
                                {order.childTests.map((child) =>
                                  renderTestInput(
                                    child.id,
                                    child.name,
                                    child.code,
                                    child.referenceRange,
                                    true,
                                    !!child.isDerived
                                  )
                                )}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div className="border-b bg-muted/30 px-4 py-3">
                              <div className="font-semibold">{panelTitle}</div>
                              {panelSubtitle && (
                                <div className="text-xs text-muted-foreground">{panelSubtitle}</div>
                              )}
                            </div>
                            <div className="p-4">
                              {renderTestInput(
                                order.testId,
                                order.testName,
                                order.testCode,
                                order.referenceRange,
                                false,
                                !!order.isDerived
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            <Button className="w-full mt-6" size="lg" onClick={handleSaveDraft} disabled={saving}>
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

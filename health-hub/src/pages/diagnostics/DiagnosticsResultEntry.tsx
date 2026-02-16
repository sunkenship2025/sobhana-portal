import { useState, useEffect } from 'react';
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
  referenceRange: ReferenceRange;
}

interface TestOrder {
  id: string;
  testId: string;
  testName: string;
  testCode: string;
  price: number;
  isPanel: boolean;
  referenceRange: ReferenceRange;
  childTests: ChildTest[];
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
        flag: string;
      }>;
    }>;
  };
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

  // Fetch visit from API
  useEffect(() => {
    const fetchVisit = async () => {
      if (!visitId || !token || !activeBranchId) return;

      try {
        setLoading(true);
        const response = await fetch(`http://localhost:3000/api/visits/diagnostic/${visitId}`, {
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
              if (r.value !== null) {
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
    setResults((prev) => ({
      ...prev,
      [testId]: value,
    }));
  };

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
          const value = parseFloat(valueStr);
          const flag = computeFlag(value, test.min, test.max);

          return {
            testId: test.testId,
            value,
            flag: flag || 'NORMAL',
            notes: ''
          };
        });

      if (resultsArray.length === 0) {
        toast.error('Please enter at least one test result');
        setSaving(false);
        return;
      }

      const response = await fetch(`http://localhost:3000/api/visits/diagnostic/${visitId}/results`, {
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
    isSubTest: boolean = false
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
          'grid gap-4 items-center py-3 border-b last:border-0',
          isSubTest ? 'grid-cols-[1fr_120px_180px_80px] pl-4' : 'grid-cols-[1fr_120px_180px_80px]'
        )}
      >
        <div>
          <Label className={cn('font-medium', isSubTest ? 'text-sm' : 'text-base')}>
            {testName}
          </Label>
          <span className="text-xs text-muted-foreground ml-2">({testCode})</span>
        </div>

        <div>
          <Input
            type={hasNumericRange ? 'number' : 'text'}
            step="0.01"
            placeholder="Value"
            value={valueStr}
            onChange={(e) => handleValueChange(testId, e.target.value)}
            className="text-center"
          />
        </div>

        <div className="text-sm text-muted-foreground text-center">
          {referenceRange.text ? (
            referenceRange.text
          ) : hasNumericRange ? (
            `${referenceRange.min || ''} – ${referenceRange.max || ''} ${referenceRange.unit}`
          ) : (
            '—'
          )}
        </div>

        <div className="flex justify-center">
          {flag ? (
            <FlagBadge flag={flag} />
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
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

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
        {/* Visit Summary - Pinned */}
        <Card className="border-primary/20 bg-accent/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
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
            <div className="grid grid-cols-[1fr_120px_180px_80px] gap-4 text-xs text-muted-foreground uppercase tracking-wide pt-4 border-b pb-2">
              <div>Test Name</div>
              <div className="text-center">Value</div>
              <div className="text-center">Reference Range</div>
              <div className="text-center">Flag</div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            {testOrders.map((order) => {
              const isPanel = order.isPanel && order.childTests && order.childTests.length > 0;
              const isExpanded = expandedPanels[order.id] ?? false;
              const filled = countFilledResults(order);
              const total = getTotalTests(order);

              return (
                <div key={order.id} className="border rounded-lg overflow-hidden">
                  {isPanel ? (
                    <>
                      {/* Panel Header */}
                      <button
                        onClick={() => togglePanel(order.id)}
                        className="w-full flex items-center justify-between p-4 bg-muted/50 hover:bg-muted/70 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-lg">{order.testName}</span>
                          <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full">
                            {order.childTests.length} parameters
                          </span>
                          <span className="text-xs text-muted-foreground">
                            ({filled}/{total} filled)
                          </span>
                        </div>
                        {isExpanded ? (
                          <ChevronUp className="h-5 w-5 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-5 w-5 text-muted-foreground" />
                        )}
                      </button>

                      {/* Panel Sub-tests */}
                      {isExpanded && (
                        <div className="p-4 bg-card">
                          {order.childTests.map((child) =>
                            renderTestInput(
                              child.id,
                              child.name,
                              child.code,
                              child.referenceRange,
                              true
                            )
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="p-4">
                      {renderTestInput(
                        order.testId,
                        order.testName,
                        order.testCode,
                        order.referenceRange,
                        false
                      )}
                    </div>
                  )}
                </div>
              );
            })}

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

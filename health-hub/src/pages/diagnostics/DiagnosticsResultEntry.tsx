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
import { AlertTriangle, Save, Loader2 } from 'lucide-react';
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

interface TestOrder {
  id: string;
  testId: string;
  testName: string;
  testCode: string;
  price: number;
  referenceRange: {
    min: number;
    max: number;
    unit: string;
  };
}

interface Visit {
  id: string;
  billNumber: string;
  status: string;
  patient: {
    name: string;
    age: number;
    gender: string;
  };
  testOrders: TestOrder[];
  report?: {
    id: string;
    currentVersion?: {
      id: string;
      status: string;
      testResults?: Array<{
        testId: string;
        value: number;
        flag: string;
      }>;
    };
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
          
          // Initialize results from existing test results if any
          if (data.report?.currentVersion?.testResults) {
            const initialResults: Record<string, string> = {};
            data.report.currentVersion.testResults.forEach((r: any) => {
              // Map testId to testOrderId
              const order = data.testOrders.find((o: any) => o.testId === r.testId);
              if (order && r.value !== null) {
                initialResults[order.id] = r.value.toString();
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

  const computeFlag = (value: number, min: number, max: number): 'NORMAL' | 'HIGH' | 'LOW' | null => {
    if (min === 0 && max === 0) return null;
    if (value < min) return 'LOW';
    if (value > max) return 'HIGH';
    return 'NORMAL';
  };

  const handleValueChange = (testOrderId: string, value: string) => {
    setResults((prev) => ({
      ...prev,
      [testOrderId]: value,
    }));
  };

  const handleSaveDraft = () => {
    // Check for extreme values first
    const extreme: string[] = [];
    testOrders.forEach((order) => {
      const valueStr = results[order.id];
      const value = valueStr ? parseFloat(valueStr) : null;
      if (value !== null && order.referenceRange.max > 0) {
        const { min, max } = order.referenceRange;
        if (value > max * 2 || value < min / 2) {
          extreme.push(order.testCode);
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
      // Prepare results array for API
      const resultsArray = testOrders
        .filter((order) => results[order.id])
        .map((order) => {
          const valueStr = results[order.id];
          const value = parseFloat(valueStr);
          const flag = computeFlag(value, order.referenceRange.min, order.referenceRange.max);
          
          return {
            testId: order.testId,
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

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        {/* Visit Summary - Pinned */}
        <Card className="border-primary/20 bg-accent/30">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">{patient.name}</h2>
                <p className="text-muted-foreground">
                  {patient.age} | {patient.gender}
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono font-bold">{visit.billNumber}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Test Results */}
        <Card>
          <CardHeader>
            <CardTitle>Test Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {testOrders.map((order) => {
              const valueStr = results[order.id] || '';
              const value = valueStr ? parseFloat(valueStr) : null;
              const flag = value !== null
                ? computeFlag(value, order.referenceRange.min, order.referenceRange.max)
                : null;

              return (
                <div key={order.id} className="space-y-2 p-4 rounded-lg border bg-card">
                  <div className="flex items-center justify-between">
                    <Label className="text-base font-semibold">{order.testName}</Label>
                    {flag && <FlagBadge flag={flag} />}
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Value</Label>
                      <Input
                        type="number"
                        step="0.1"
                        placeholder="Enter value"
                        value={valueStr}
                        onChange={(e) => handleValueChange(order.id, e.target.value)}
                        className="text-lg"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Reference Range</Label>
                      <div className="h-10 flex items-center text-muted-foreground">
                        {order.referenceRange.min > 0 || order.referenceRange.max > 0
                          ? `${order.referenceRange.min} – ${order.referenceRange.max} ${order.referenceRange.unit}`
                          : 'N/A'}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Flag</Label>
                      <div className="h-10 flex items-center">
                        {flag ? (
                          <FlagBadge flag={flag} className="text-sm" />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            <Button className="w-full" size="lg" onClick={handleSaveDraft} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {saving ? 'Saving...' : 'Save Draft'}
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

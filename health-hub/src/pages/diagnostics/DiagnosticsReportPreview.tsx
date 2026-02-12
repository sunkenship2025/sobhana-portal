import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { FlagBadge } from '@/components/ui/flag-badge';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CheckCircle2, Lock, Printer, MessageCircle, Loader2 } from 'lucide-react';
import { ReportPrint } from '@/components/print/ReportPrint';
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

interface Visit {
  id: string;
  billNumber: string;
  status: string;
  createdAt: string;
  patient: {
    name: string;
    age: number;
    gender: string;
    identifiers?: Array<{ type: string; value: string }>;
  };
  testOrders: Array<{
    id: string;
    testId: string;
    testName: string;
    testCode: string;
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
  };
}

const DiagnosticsReportPreview = () => {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loading, setLoading] = useState(true);
  const [finalizing, setFinalizing] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [reportToken, setReportToken] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement>(null);

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
          
          // E3-10: Check if report is finalized and has an access token
          const latestVersion = data.report?.versions?.[0];
          if (latestVersion?.status === 'FINALIZED' && latestVersion?.accessToken) {
            setReportToken(latestVersion.accessToken);
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

  const { patient, testOrders, referralDoctor } = visit;
  // Get test results from the latest version (versions are ordered by versionNum desc)
  const latestVersion = (visit.report as any)?.versions?.[0];
  const testResults = latestVersion?.testResults || [];
  
  // Group results by parent test order for proper display
  // Each result now includes testName, testCode, and referenceRange from the backend
  const groupedResults = testOrders.map((order: any) => {
    // Find all results that belong to this test order (parent or sub-tests)
    const orderResults = testResults.filter((r: any) => r.testOrderId === order.id);
    return {
      order,
      results: orderResults.map((result: any) => ({
        ...result,
        // testName, testCode, referenceRange are now provided by backend
        testName: result.testName || 'Unknown Test',
        testCode: result.testCode || '',
        referenceRange: result.referenceRange || { min: 0, max: 0, unit: '' }
      }))
    };
  }).filter((g: any) => g.results.length > 0);

  // Flatten for backward compatibility
  const results = groupedResults.flatMap((g: any) => g.results);
  
  const hasAbnormalValues = results.some((r) => r.flag === 'HIGH' || r.flag === 'LOW');
  const isFinalized = visit.status === 'COMPLETED';

  const handleFinalize = async () => {
    setFinalizing(true);
    try {
      const response = await fetch(`http://localhost:3000/api/visits/diagnostic/${visitId}/finalize`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
          'Content-Type': 'application/json'
        }
      });

      if (response.ok) {
        const data = await response.json();
        const newReportToken = data.reportToken;
        
        if (newReportToken) {
          setReportToken(newReportToken);
          toast.success('Report finalized successfully');
        } else {
          toast.warning('Report finalized but access link generation failed');
        }
        
        setShowConfirm(false);
        
        // Refresh visit data
        const refreshResponse = await fetch(`http://localhost:3000/api/visits/diagnostic/${visitId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId
          }
        });
        if (refreshResponse.ok) {
          const refreshData = await refreshResponse.json();
          setVisit(refreshData);
        }
        
        // Auto-send WhatsApp message with secure report link
        const phone = patient.identifiers?.find(id => id.type === 'PHONE')?.value;
        if (phone && newReportToken) {
          const reportUrl = `${window.location.origin}/r/${newReportToken}`;
          const message = `🔬 Lab Report Ready!\n\nDear ${patient.name},\n\nYour lab report (Bill #: ${visit.billNumber}) is now ready.\n\nView your report: ${reportUrl}\n\nThank you for choosing Sobhana Diagnostics.`;
          const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
          window.open(url, '_blank');
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

  const handlePrint = () => {
    if (reportToken) {
      // Open the backend-rendered report page which has proper print CSS
      window.open(`/r/${reportToken}`, '_blank');
    } else {
      toast.error('Report token not available. Please finalize the report first.');
    }
  };

  const handleWhatsApp = () => {
    const phone = patient.identifiers?.find(id => id.type === 'PHONE')?.value;
    if (phone) {
      if (reportToken) {
        const reportUrl = `${window.location.origin}/r/${reportToken}`;
        const message = `🔬 Lab Report Ready\n\nPatient: ${patient.name}\nBill #: ${visit.billNumber}\n\nView Report: ${reportUrl}\n\nThank you for choosing Sobhana Diagnostics.`;
        const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
      } else {
        const message = `Lab Report Ready\n\nPatient: ${patient.name}\nBill #: ${visit.billNumber}\n\nPlease visit the clinic to collect your report.`;
        const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
        window.open(url, '_blank');
      }
    }
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
              <Button variant="outline" onClick={handleWhatsApp}>
                <MessageCircle className="mr-2 h-4 w-4" />
                WhatsApp
              </Button>
            </div>
          )}
        </div>

        {/* Report Card */}
        <Card className={isFinalized ? 'border-success/30' : 'border-warning/30'}>
          <CardHeader className="border-b">
            <div className="flex justify-between">
              <div>
                <CardTitle>{patient.name}</CardTitle>
                <p className="text-muted-foreground">
                  {patient.age} years | {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}
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
            {/* Results Table */}
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

            {/* Abnormal Values Warning */}
            {hasAbnormalValues && !isFinalized && (
              <div className="mt-4 p-3 rounded-lg bg-warning/10 border border-warning/30 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" />
                <span className="text-sm font-medium">Abnormal values detected</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Actions */}
        {!isFinalized && (
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              className="flex-1"
              onClick={() => navigate(`/diagnostics/results/${visit.id}`)}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Edit
            </Button>
            <Button 
              className="flex-1"
              onClick={() => setShowConfirm(true)}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Finalize Report
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
                  {reportToken && (
                    <a 
                      href={`/r/${reportToken}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary hover:underline mt-1 inline-block"
                    >
                      View Official Report →
                    </a>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

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
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleFinalize} disabled={finalizing}>
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

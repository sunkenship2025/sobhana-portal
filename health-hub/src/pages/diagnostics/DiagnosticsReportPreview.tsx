import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/appStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { FlagBadge } from '@/components/ui/flag-badge';
import { toast } from 'sonner';
import { AlertTriangle, ArrowLeft, CheckCircle2, Lock, Printer, MessageCircle } from 'lucide-react';
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

const DiagnosticsReportPreview = () => {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { getDiagnosticVisitView, updateDiagnosticVisit, updateReportVersion } = useAppStore();
  const [showConfirm, setShowConfirm] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const visitView = visitId ? getDiagnosticVisitView(visitId) : undefined;

  if (!visitView) {
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

  const { visit, patient, referralDoctor, results, currentReportVersion } = visitView;
  
  const hasAbnormalValues = results.some((r) => r.flag === 'HIGH' || r.flag === 'LOW');
  const isFinalized = visit.status === 'FINALIZED';

  const handleFinalize = () => {
    // Update visit status (immutable after this)
    updateDiagnosticVisit(visit.id, { status: 'FINALIZED' });
    
    // Update report version status
    if (currentReportVersion) {
      updateReportVersion(currentReportVersion.id, { 
        status: 'FINALIZED',
        finalizedAt: new Date(),
      });
    }
    
    toast.success('Report finalized successfully');
    setShowConfirm(false);
    
    // Auto-send WhatsApp message to patient
    const message = `🔬 Lab Report Ready!\n\nDear ${patient.name},\n\nYour lab report (Bill #: ${visit.billNumber}) is now ready.\n\nPlease visit the clinic to collect your report.\n\nThank you for choosing MedCare.`;
    const url = `https://wa.me/${patient.phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  const handlePrint = () => {
    window.print();
  };

  const handleWhatsApp = () => {
    const message = `Lab Report Ready\n\nPatient: ${patient.name}\nBill #: ${visit.billNumber}\n\nPlease visit the clinic to collect your report.`;
    const url = `https://wa.me/${patient.phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
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
                      <FlagBadge flag={result.flag} />
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
          <Card className="bg-success/5 border-success/30">
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-8 w-8 text-success" />
                <div>
                  <p className="font-semibold">Report Finalized</p>
                  <p className="text-sm text-muted-foreground">
                    This report is now locked and cannot be edited.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Print Content - Only this prints */}
      <div ref={printRef} className="hidden print:block">
        <ReportPrint visitView={visitView} />
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
            <AlertDialogAction onClick={handleFinalize}>
              <Lock className="mr-2 h-4 w-4" />
              Finalize Report
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default DiagnosticsReportPreview;

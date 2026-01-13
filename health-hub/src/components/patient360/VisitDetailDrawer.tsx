/**
 * Visit Detail Drawer
 * 
 * Side drawer that shows detailed information about a visit.
 * Does NOT navigate away from Patient 360 context.
 * 
 * RULES:
 * - Always read-only from Patient 360
 * - Shows different content based on domain (Diagnostics vs Clinic)
 * - Report link visible only for finalized reports
 */

import { useQuery } from '@tanstack/react-query';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Building2, 
  Calendar,
  CreditCard,
  FileText,
  FlaskConical,
  Lock,
  Printer,
  Stethoscope,
  User
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import type { VisitTimelineItem, DiagnosticVisitDetail, ClinicVisitDetail } from '@/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

interface VisitDetailDrawerProps {
  visit: VisitTimelineItem | null;
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

async function fetchDiagnosticDetail(
  patientId: string, 
  visitId: string, 
  token: string
): Promise<DiagnosticVisitDetail> {
  const res = await fetch(
    `${API_BASE}/patients/${patientId}/360/visits/${visitId}/diagnostic`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error('Failed to fetch visit detail');
  return res.json();
}

async function fetchClinicDetail(
  patientId: string,
  visitId: string,
  token: string
): Promise<ClinicVisitDetail> {
  const res = await fetch(
    `${API_BASE}/patients/${patientId}/360/visits/${visitId}/clinic`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!res.ok) throw new Error('Failed to fetch visit detail');
  return res.json();
}

export function VisitDetailDrawer({ 
  visit, 
  patientId, 
  open, 
  onOpenChange 
}: VisitDetailDrawerProps) {
  const { token } = useAuthStore();

  // Fetch diagnostic detail
  const { data: diagnosticDetail, isLoading: loadingDiagnostic } = useQuery({
    queryKey: ['diagnosticVisitDetail', visit?.visitId],
    queryFn: () => fetchDiagnosticDetail(patientId, visit!.visitId, token!),
    enabled: open && !!visit && visit.domain === 'DIAGNOSTICS' && !!token,
  });

  // Fetch clinic detail
  const { data: clinicDetail, isLoading: loadingClinic } = useQuery({
    queryKey: ['clinicVisitDetail', visit?.visitId],
    queryFn: () => fetchClinicDetail(patientId, visit!.visitId, token!),
    enabled: open && !!visit && visit.domain === 'CLINIC' && !!token,
  });

  const isLoading = (visit?.domain === 'DIAGNOSTICS' && loadingDiagnostic) || 
                    (visit?.domain === 'CLINIC' && loadingClinic);

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatAmount = (paise: number) => {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  if (!visit) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {visit.domain === 'DIAGNOSTICS' ? (
              <FlaskConical className="h-5 w-5 text-primary" />
            ) : (
              <Stethoscope className="h-5 w-5 text-context-clinic" />
            )}
            {visit.domain === 'DIAGNOSTICS' ? 'Diagnostic Visit' : `Clinic Visit (${visit.visitType})`}
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="space-y-4 mt-6">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* Branch Context Notice */}
            <div className="flex items-center gap-2 p-3 bg-muted rounded-lg text-sm">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span>This visit was handled at <strong>{visit.branchName}</strong></span>
            </div>

            {/* Visit Info */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Calendar className="h-4 w-4" />
                  Date
                </span>
                <span className="font-medium">{formatDate(visit.visitDate)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Bill Number</span>
                <span className="font-mono">{visit.billNumber}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <CreditCard className="h-4 w-4" />
                  Payment
                </span>
                <div className="flex items-center gap-2">
                  <Badge variant={visit.paymentStatus === 'PAID' ? 'default' : 'outline'}>
                    {visit.paymentStatus}
                  </Badge>
                  <span className="text-sm">{visit.paymentType}</span>
                </div>
              </div>
            </div>

            <Separator />

            {/* Domain-Specific Content */}
            {visit.domain === 'DIAGNOSTICS' && diagnosticDetail && (
              <DiagnosticDetailContent detail={diagnosticDetail} />
            )}
            
            {visit.domain === 'CLINIC' && clinicDetail && (
              <ClinicDetailContent detail={clinicDetail} />
            )}

            {/* Referral Doctor */}
            {visit.referralDoctorName && (
              <>
                <Separator />
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Referred By
                  </h4>
                  <p className="text-sm">{visit.referralDoctorName}</p>
                </div>
              </>
            )}

            {/* Report Actions (Diagnostics only, Finalized only) */}
            {visit.domain === 'DIAGNOSTICS' && visit.reportFinalized && (
              <>
                <Separator />
                <div className="space-y-3">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <Lock className="h-4 w-4 text-green-600" />
                    Report Finalized
                  </h4>
                  {visit.reportFinalizedAt && (
                    <p className="text-xs text-muted-foreground">
                      Finalized on {formatDate(visit.reportFinalizedAt)}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(`/diagnostics/preview/${visit.visitId}`, '_blank')}
                    >
                      <FileText className="h-4 w-4 mr-2" />
                      View Report
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(`/diagnostics/preview/${visit.visitId}?print=true`, '_blank')}
                    >
                      <Printer className="h-4 w-4 mr-2" />
                      Print Report
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DiagnosticDetailContent({ detail }: { detail: DiagnosticVisitDetail }) {
  const formatAmount = (paise: number) => {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  const getFlagColor = (flag: string | null) => {
    switch (flag) {
      case 'HIGH':
        return 'text-red-600 bg-red-50';
      case 'LOW':
        return 'text-blue-600 bg-blue-50';
      default:
        return 'text-green-600 bg-green-50';
    }
  };

  return (
    <div className="space-y-4">
      {/* Tests Ordered */}
      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <FlaskConical className="h-4 w-4" />
          Tests Ordered ({detail.testOrders.length})
        </h4>
        <div className="space-y-2">
          {detail.testOrders.map((test) => {
            const result = detail.results?.find(r => r.testOrderId === test.id);
            return (
              <div 
                key={test.id} 
                className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
              >
                <div>
                  <p className="font-medium text-sm">{test.testName}</p>
                  <p className="text-xs text-muted-foreground font-mono">{test.testCode}</p>
                </div>
                <div className="text-right">
                  {result ? (
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">
                        {result.value !== null ? result.value : '—'}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {test.referenceRange.unit}
                      </span>
                      {result.flag && (
                        <Badge 
                          variant="outline" 
                          className={`text-xs ${getFlagColor(result.flag)}`}
                        >
                          {result.flag}
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Pending</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Total */}
      <div className="flex items-center justify-between pt-2 border-t">
        <span className="font-semibold">Total</span>
        <span className="font-bold text-lg">{formatAmount(detail.totalAmountInPaise)}</span>
      </div>
    </div>
  );
}

function ClinicDetailContent({ detail }: { detail: ClinicVisitDetail }) {
  const formatAmount = (paise: number) => {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  return (
    <div className="space-y-4">
      {/* Clinic Doctor */}
      <div>
        <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Stethoscope className="h-4 w-4" />
          Consulting Doctor
        </h4>
        <div className="p-3 bg-muted/50 rounded-lg">
          <p className="font-medium">{detail.clinicDoctor.name}</p>
          <p className="text-sm text-muted-foreground">{detail.clinicDoctor.qualification}</p>
          <p className="text-sm text-muted-foreground">{detail.clinicDoctor.specialty}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Reg. No: {detail.clinicDoctor.registrationNumber}
          </p>
        </div>
      </div>

      {/* Visit Type & Ward */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Visit Type</p>
          <Badge variant="outline" className="mt-1">
            {detail.visitType === 'OP' ? 'Outpatient' : 'Inpatient'}
          </Badge>
        </div>
        {detail.hospitalWard && (
          <div>
            <p className="text-sm text-muted-foreground">Ward</p>
            <p className="font-medium mt-1">{detail.hospitalWard}</p>
          </div>
        )}
      </div>

      {/* Consultation Fee */}
      <div className="flex items-center justify-between pt-2 border-t">
        <span className="font-semibold">Consultation Fee</span>
        <span className="font-bold text-lg">{formatAmount(detail.consultationFeeInPaise)}</span>
      </div>
    </div>
  );
}

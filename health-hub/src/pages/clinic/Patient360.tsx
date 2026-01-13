import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft, FileText, ChevronRight, User, Lock } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import type { Patient360View, VisitTimelineItem, VisitDomain } from '@/types';

const API_BASE = 'http://localhost:3000/api';

// API call for Patient 360 data
const fetchPatient360 = async (
  patientId: string,
  token: string | null
): Promise<Patient360View | null> => {
  const branchId = useBranchStore.getState().activeBranchId || 'cmjzumgap00003zwljoqlubsn';
  const response = await fetch(`${API_BASE}/patients/${patientId}/360`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-branch-id': branchId, // Use valid branch ID from store
    },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error('Failed to fetch patient data');
  }

  return response.json();
};

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatCurrency(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function getDomainBadgeVariant(domain: VisitDomain): 'default' | 'secondary' {
  return domain === 'DIAGNOSTICS' ? 'default' : 'secondary';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'FINALIZED':
    case 'COMPLETED':
      return 'text-green-600';
    case 'IN_PROGRESS':
    case 'DRAFT':
      return 'text-amber-600';
    case 'WAITING':
      return 'text-blue-600';
    default:
      return 'text-muted-foreground';
  }
}

interface VisitDetailDrawerProps {
  visit: VisitTimelineItem | null;
  open: boolean;
  onClose: () => void;
}

function VisitDetailDrawer({ visit, open, onClose }: VisitDetailDrawerProps) {
  if (!visit) return null;

  const isDiagnostic = visit.domain === 'DIAGNOSTICS';

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Visit Details
            <Badge variant="outline" className="text-xs font-normal">
              Read-Only
            </Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Visit Type Header */}
          <div>
            <h3 className="font-semibold text-lg">
              {isDiagnostic
                ? 'Diagnostic Visit'
                : `Clinic Visit — ${visit.visitType}`}
            </h3>
            <p className="text-sm text-muted-foreground">
              Branch: {visit.branchName}
            </p>
            <p className="text-sm text-muted-foreground">
              Date: {formatDate(visit.createdAt)}
            </p>
            {!isDiagnostic && visit.doctorName && (
              <p className="text-sm text-muted-foreground">
                Doctor: {visit.doctorName}
              </p>
            )}
          </div>

          <Separator />

          {/* Billing Summary */}
          <div>
            <h4 className="font-medium mb-3">Billing Summary</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-medium">{formatCurrency(visit.totalAmountInPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment</span>
                <span>{visit.paymentType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <span className={visit.paymentStatus === 'PAID' ? 'text-green-600' : 'text-amber-600'}>
                  {visit.paymentStatus}
                </span>
              </div>
            </div>
          </div>

          {/* Diagnostic Report Status */}
          {isDiagnostic && (
            <>
              <Separator />
              <div>
                <h4 className="font-medium mb-3">Report Status</h4>
                <p className={`text-sm ${getStatusColor(visit.reportStatus || visit.status)}`}>
                  {visit.reportStatus === 'FINALIZED'
                    ? 'Report Finalized'
                    : visit.reportStatus === 'DRAFT'
                    ? 'Results Pending'
                    : 'No Report'}
                </p>
                {visit.finalizedAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Finalized on {formatDate(visit.finalizedAt)}
                  </p>
                )}
              </div>
            </>
          )}

          <Separator />

          {/* Read-Only Notice */}
          <div className="bg-muted/50 rounded-lg p-4 flex items-start gap-3">
            <Lock className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Read-Only View</p>
              <p className="mt-1">
                This visit was handled at the {visit.branchName} branch.
                No changes can be made from Patient 360.
              </p>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function Patient360() {
  const { patientId } = useParams<{ patientId: string }>();
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const [patient360, setPatient360] = useState<Patient360View | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState<VisitTimelineItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (patientId) {
      loadPatient360(patientId);
    }
  }, [patientId]);

  const loadPatient360 = async (id: string) => {
    setIsLoading(true);
    try {
      const data = await fetchPatient360(id, token);
      setPatient360(data);
    } catch (error) {
      console.error('Failed to load patient 360:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleViewVisitDetails = (visit: VisitTimelineItem) => {
    setSelectedVisit(visit);
    setDrawerOpen(true);
  };

  const handleViewReport = (reportVersionId: string) => {
    // Navigate to report preview in read-only mode
    // The report preview page should detect this is from Patient 360 and enforce read-only
    window.open(`/diagnostics/preview/${reportVersionId}?readonly=true`, '_blank');
  };

  if (isLoading) {
    return (
      <AppLayout context="clinic" subContext="Patient 360">
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      </AppLayout>
    );
  }

  if (!patient360) {
    return (
      <AppLayout context="clinic" subContext="Patient 360">
        <div className="text-center py-12">
          <User className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h2 className="text-lg font-medium">Patient not found</h2>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate('/clinic/patient-search')}
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Search
          </Button>
        </div>
      </AppLayout>
    );
  }

  const { patient, visitTimeline } = patient360;
  const primaryPhone = patient.identifiers.find((i) => i.type === 'PHONE')?.value;

  return (
    <AppLayout context="clinic" subContext="Patient 360">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Back Button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/clinic/patient-search')}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Search
        </Button>

        {/* Header Banner */}
        <div className="bg-muted/50 rounded-lg px-6 py-3 flex items-center gap-2 text-sm">
          <span className="font-medium">Patient 360</span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground">Global History</span>
          <span className="text-muted-foreground">•</span>
          <span className="text-muted-foreground flex items-center gap-1">
            <Lock className="h-3 w-3" />
            Read-Only
          </span>
        </div>

        {/* Patient Identity Card (Sticky / Immutable) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">Patient Identity</CardTitle>
              <Badge variant="outline" className="text-xs">
                {patient.patientNumber}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-2xl font-bold">{patient.name}</h3>
                <p className="text-muted-foreground">
                  {patient.age} years | {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}
                </p>
              </div>
              <div className="space-y-1 text-sm">
                {primaryPhone && (
                  <p>
                    <span className="text-muted-foreground">Phone:</span>{' '}
                    {primaryPhone.slice(0, 5)}XXXXX
                  </p>
                )}
                {patient.address && (
                  <p>
                    <span className="text-muted-foreground">Address:</span>{' '}
                    {patient.address}
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                Global Patient Record — Registered {formatDate(patient.createdAt)}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Visit Timeline */}
        <div>
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            Visit Timeline
            <span className="text-sm font-normal text-muted-foreground">
              (Newest → Oldest)
            </span>
          </h2>

          {visitTimeline.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <p>No visits recorded for this patient.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {visitTimeline.map((visit) => {
                const isDiagnostic = visit.domain === 'DIAGNOSTICS';
                const canViewReport =
                  isDiagnostic && visit.reportStatus === 'FINALIZED' && visit.reportVersionId;

                return (
                  <Card key={visit.visitId} className="overflow-hidden">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        {/* Left: Visit Info */}
                        <div className="flex-1 min-w-0">
                          {/* Visit Type Header */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant={getDomainBadgeVariant(visit.domain)}>
                              {isDiagnostic ? 'DIAGNOSTIC VISIT' : `CLINIC VISIT`}
                            </Badge>
                            {!isDiagnostic && visit.visitType && (
                              <Badge variant="outline">{visit.visitType}</Badge>
                            )}
                            <span className="text-sm text-muted-foreground">
                              • {visit.branchName}
                            </span>
                          </div>

                          {/* Date */}
                          <p className="text-sm text-muted-foreground mt-2">
                            {formatDate(visit.createdAt)}
                          </p>

                          {/* Status / Doctor */}
                          <div className="mt-2 space-y-1">
                            {isDiagnostic ? (
                              <p className={`text-sm ${getStatusColor(visit.reportStatus || visit.status)}`}>
                                Status:{' '}
                                {visit.reportStatus === 'FINALIZED'
                                  ? 'Report Finalized'
                                  : 'Results Pending'}
                              </p>
                            ) : (
                              visit.doctorName && (
                                <p className="text-sm">
                                  Doctor: {visit.doctorName}
                                </p>
                              )
                            )}

                            {/* Billing Info */}
                            <p className="text-sm text-muted-foreground">
                              Billing: {formatCurrency(visit.totalAmountInPaise)} ·{' '}
                              {visit.paymentType} ·{' '}
                              <span className={visit.paymentStatus === 'PAID' ? 'text-green-600' : 'text-amber-600'}>
                                {visit.paymentStatus}
                              </span>
                            </p>
                          </div>
                        </div>

                        {/* Right: Actions */}
                        <div className="flex flex-col gap-2 shrink-0">
                          {canViewReport ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleViewReport(visit.reportVersionId!)}
                              className="text-xs"
                            >
                              <FileText className="h-3 w-3 mr-1" />
                              View Final Report
                            </Button>
                          ) : isDiagnostic && !visit.reportVersionId ? (
                            <span className="text-xs text-muted-foreground italic">
                              (no report available)
                            </span>
                          ) : null}

                          {!isDiagnostic && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewVisitDetails(visit)}
                              className="text-xs"
                            >
                              View Visit Details
                              <ChevronRight className="h-3 w-3 ml-1" />
                            </Button>
                          )}

                          {isDiagnostic && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleViewVisitDetails(visit)}
                              className="text-xs"
                            >
                              View Details
                              <ChevronRight className="h-3 w-3 ml-1" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer Notice */}
        <div className="bg-muted/30 rounded-lg p-4 text-center text-sm text-muted-foreground">
          <p>
            This is a complete, read-only record of the patient's history
            across all Sobhana branches.
          </p>
        </div>
      </div>

      {/* Visit Detail Drawer */}
      <VisitDetailDrawer
        visit={selectedVisit}
        open={drawerOpen}
        onClose={() => {
          setDrawerOpen(false);
          setSelectedVisit(null);
        }}
      />
    </AppLayout>
  );
}

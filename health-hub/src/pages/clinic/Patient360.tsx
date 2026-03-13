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
import { ArrowLeft, FileText, ChevronRight, User, Lock, IndianRupee, Printer, MessageCircle, Eye, X, Loader2, Download } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import type { Patient360View, VisitTimelineItem, VisitDomain } from '@/types';
import { toast } from 'sonner';
import { PatientEditDialog } from '@/components/patient360/PatientEditDialog';

/**
 * PATIENT 360 — CANONICAL PATIENT VIEW (Phase-1)
 * 
 * Entry Points:
 * 1. Branch Patient Table (future) - Lists patients with activity in current branch
 * 2. Global Search (/clinic/patient-search) - Search by phone/name across all branches
 * 
 * This screen shows:
 * - Complete medical and financial history across ALL branches
 * - Read-only view of all visits, bills, and reports
 * - Global patient identity (immutable)
 * - Visit timeline with branch-scoped operations
 * 
 * Security:
 * - Patient 360 ignores branch filters for viewing history
 * - Report links only shown for FINALIZED diagnostics reports
 * - No editing allowed (read-only view)
 */

import { API_BASE, API_BASE_URL } from '@/lib/api';

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
  patientPhone?: string;
  patientName?: string;
  onPreviewReport?: (token: string) => void;
}

function VisitDetailDrawer({ visit, open, onClose, patientPhone, patientName, onPreviewReport }: VisitDetailDrawerProps) {
  const { token } = useAuthStore();
  
  if (!visit) return null;

  const isDiagnostic = visit.domain === 'DIAGNOSTICS';

  const handlePreviewReport = () => {
    if (!visit.reportAccessToken) {
      toast.error('Report not available.');
      return;
    }
    onPreviewReport?.(visit.reportAccessToken);
  };

  const handlePrintReport = () => {
    if (!visit.reportAccessToken) {
      toast.error('Report not available.');
      return;
    }
    const printWindow = window.open(`${API_BASE_URL}/reports/${visit.reportAccessToken}/view`, '_blank');
    if (printWindow) {
      printWindow.addEventListener('load', () => {
        setTimeout(() => printWindow.print(), 500);
      });
    }
  };

  const handleWhatsAppReport = async () => {
    if (!visit.reportAccessToken) {
      toast.error('Report link not available.');
      return;
    }
    try {
      const branchId = useBranchStore.getState().activeBranchId;
      const response = await fetch(`${API_BASE}/messages/${visit.visitId}/send-report`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': branchId,
        },
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success('Report notification sent via WhatsApp');
      } else {
        toast.error(data.error || 'Failed to send WhatsApp notification');
      }
    } catch (error) {
      toast.error('Failed to send WhatsApp notification');
    }
  };

  const handlePrintBill = () => {
    // Open bill print page in new tab
    window.open(`/bill/print/${visit.domain}/${visit.visitId}`, '_blank');
  };

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
            <div className="mt-2 space-y-1 text-sm text-muted-foreground">
              <p>Branch: <span className="text-foreground font-medium">{visit.branchName}</span></p>
              <p>Date: <span className="text-foreground">{formatDate(visit.createdAt)}</span></p>
              <p>Bill Number: <span className="text-foreground font-mono">{visit.billNumber}</span></p>
              {!isDiagnostic && visit.doctorName && (
                <p>Doctor: <span className="text-foreground">{visit.doctorName}</span></p>
              )}
            </div>
          </div>

          <Separator />

          {/* Billing Summary */}
          <div>
            <h4 className="font-medium mb-3">Billing Summary</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold">{formatCurrency(visit.totalAmountInPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment Method</span>
                <span>{visit.paymentType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Payment Status</span>
                <span className={visit.paymentStatus === 'PAID' ? 'text-green-600 font-medium' : 'text-amber-600 font-medium'}>
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
                <p className={`text-sm font-medium ${getStatusColor(visit.reportStatus || visit.status)}`}>
                  {visit.reportStatus === 'FINALIZED'
                    ? '✓ Report Finalized'
                    : visit.reportStatus === 'DRAFT'
                    ? '⏳ Results Pending'
                    : '— No Report Available'}
                </p>
                {visit.finalizedAt && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Finalized on {formatDate(visit.finalizedAt)}
                  </p>
                )}
                {visit.reportStatus === 'FINALIZED' && visit.reportAccessToken && (
                  <div className="mt-3 space-y-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePreviewReport}
                      className="w-full"
                    >
                      <Eye className="h-4 w-4 mr-2" />
                      Preview Report
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePrintReport}
                      className="w-full"
                    >
                      <Printer className="h-4 w-4 mr-2" />
                      Print Report
                    </Button>
                    {patientPhone && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleWhatsAppReport}
                        className="w-full text-green-600 hover:text-green-700 hover:bg-green-50"
                      >
                        <MessageCircle className="h-4 w-4 mr-2" />
                        Send on WhatsApp
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <Separator />

          {/* Print Bill Button */}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrintBill}
              className="w-full"
            >
              <Printer className="h-4 w-4 mr-2" />
              Print Bill
            </Button>
          </div>

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
  const { activeBranchId } = useBranchStore();
  const [patient360, setPatient360] = useState<Patient360View | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState<VisitTimelineItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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

  const handlePreviewReport = async (reportAccessToken: string) => {
    setPreviewLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/reports/${reportAccessToken}/view`);
      if (response.ok) {
        const html = await response.text();
        setPreviewHtml(html);
        setShowPreview(true);
      } else {
        toast.error('Failed to load report preview');
      }
    } catch (error) {
      console.error('Preview failed:', error);
      toast.error('Failed to load report preview');
    } finally {
      setPreviewLoading(false);
    }
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

        {/* Patient Identity Card (Editable) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xl">Patient Identity</CardTitle>
              <div className="flex items-center gap-2">
                <PatientEditDialog
                  patient={patient}
                  token={token}
                  onSuccess={() => loadPatient360(patientId)}
                />
                <Badge variant="outline" className="text-xs">
                  {patient.patientNumber}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-2xl font-bold">{patient.name}</h3>
                <p className="text-muted-foreground">
                  {(patient as any).ageDisplay || `${patient.age} years`} | {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}
                </p>
                {patient.dateOfBirth && (
                  <p className="text-sm text-muted-foreground">
                    DOB: {new Date(patient.dateOfBirth).toLocaleDateString('en-IN', { 
                      day: '2-digit', 
                      month: 'short', 
                      year: 'numeric' 
                    })}
                  </p>
                )}
              </div>
              <div className="space-y-1 text-sm">
                {primaryPhone && (
                  <p>
                    <span className="text-muted-foreground">Phone:</span>{' '}
                    {primaryPhone}
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

        {/* Financial Summary (Read-Only) */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <IndianRupee className="h-5 w-5" />
                Financial Summary
              </CardTitle>
              <Badge variant="outline" className="text-xs">
                Read-Only
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-3 gap-4">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Total Diagnostics</p>
                <p className="text-xl font-semibold">
                  {formatCurrency(
                    visitTimeline
                      .filter(v => v.domain === 'DIAGNOSTICS')
                      .reduce((sum, v) => sum + v.totalAmountInPaise, 0)
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Total Clinic</p>
                <p className="text-xl font-semibold">
                  {formatCurrency(
                    visitTimeline
                      .filter(v => v.domain === 'CLINIC')
                      .reduce((sum, v) => sum + v.totalAmountInPaise, 0)
                  )}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Lifetime Total</p>
                <p className="text-xl font-semibold text-primary">
                  {formatCurrency(
                    visitTimeline.reduce((sum, v) => sum + v.totalAmountInPaise, 0)
                  )}
                </p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                ⚠️ All financial changes happen via visits/bills. This is informational only.
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
                  isDiagnostic && visit.reportStatus === 'FINALIZED' && visit.reportAccessToken;

                return (
                  <Card key={visit.visitId} className="overflow-hidden">
                    <CardContent className="p-4">
                      <div className="grid grid-cols-[auto_1fr_auto] gap-4 items-start">
                        {/* Date Column */}
                        <div className="text-sm font-medium min-w-[100px]">
                          {formatDate(visit.createdAt)}
                        </div>

                        {/* Visit Details Column */}
                        <div className="flex-1 space-y-2">
                          {/* Visit Type Header */}
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant={getDomainBadgeVariant(visit.domain)}>
                              {isDiagnostic ? 'DIAGNOSTICS' : `CLINIC`}
                            </Badge>
                            {!isDiagnostic && visit.visitType && (
                              <Badge variant="outline" className="text-xs">
                                {visit.visitType}
                              </Badge>
                            )}
                            <span className="text-sm text-muted-foreground">
                              • {visit.branchName}
                            </span>
                            <span className="text-xs text-muted-foreground font-mono">
                              • {visit.billNumber}
                            </span>
                          </div>

                          {/* Status / Doctor */}
                          <div className="space-y-1">
                            {isDiagnostic ? (
                              <p className={`text-sm ${getStatusColor(visit.reportStatus || visit.status)}`}>
                                Status:{' '}
                                {visit.reportStatus === 'FINALIZED'
                                  ? 'Report Finalized'
                                  : visit.reportStatus === 'DRAFT'
                                  ? 'Results Pending'
                                  : 'No Report'}
                              </p>
                            ) : (
                              visit.doctorName && (
                                <p className="text-sm text-muted-foreground">
                                  Doctor: <span className="text-foreground">{visit.doctorName}</span>
                                </p>
                              )
                            )}

                            {/* Billing Info */}
                            <p className="text-sm">
                              <span className="font-semibold">{formatCurrency(visit.totalAmountInPaise)}</span>
                              <span className="text-muted-foreground"> · {visit.paymentType} · </span>
                              <span className={visit.paymentStatus === 'PAID' ? 'text-green-600 font-medium' : 'text-amber-600'}>
                                {visit.paymentStatus}
                              </span>
                            </p>
                          </div>
                        </div>

                        {/* Actions Column */}
                        <div className="flex flex-col gap-2 shrink-0 min-w-[140px]">
                          {/* Preview Report Button - ONLY for FINALIZED diagnostics */}
                          {canViewReport && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handlePreviewReport(visit.reportAccessToken!)}
                              disabled={previewLoading}
                              className="text-xs w-full justify-start"
                            >
                              {previewLoading ? (
                                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                              ) : (
                                <Eye className="h-3 w-3 mr-2" />
                              )}
                              {previewLoading ? 'Loading...' : 'View Report'}
                            </Button>
                          )}

                          {/* View Details Button */}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleViewVisitDetails(visit)}
                            className="text-xs w-full justify-start"
                          >
                            View Details
                            <ChevronRight className="h-3 w-3 ml-auto" />
                          </Button>
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
        patientPhone={primaryPhone}
        patientName={patient.name}
        onPreviewReport={(token) => {
          setDrawerOpen(false);
          handlePreviewReport(token);
        }}
      />

      {/* Full-Screen Report Preview Modal */}
      {showPreview && previewHtml && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col">
          {/* Modal Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b bg-background">
            <div className="flex items-center gap-3">
              <Eye className="h-5 w-5 text-primary" />
              <div>
                <h2 className="font-semibold text-lg">Report Preview</h2>
                <p className="text-xs text-muted-foreground">Finalized report — read-only view</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {primaryPhone && selectedVisit?.reportAccessToken && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      const response = await fetch(`${API_BASE}/messages/${selectedVisit.visitId}/send-report`, {
                        method: 'POST',
                        headers: {
                          'Authorization': `Bearer ${token}`,
                          'Content-Type': 'application/json',
                          'X-Branch-Id': activeBranchId,
                        },
                      });
                      const data = await response.json();
                      if (response.ok && data.success) {
                        toast.success('Report notification sent via WhatsApp');
                      } else {
                        toast.error(data.error || 'Failed to send WhatsApp notification');
                      }
                    } catch (error) {
                      toast.error('Failed to send WhatsApp notification');
                    }
                  }}
                  className="text-green-600 hover:text-green-700"
                >
                  <MessageCircle className="h-4 w-4 mr-2" />
                  WhatsApp
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setShowPreview(false);
                  setPreviewHtml(null);
                }}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>
          {/* Iframe with Report HTML */}
          <div className="flex-1 overflow-hidden bg-muted p-4">
            <iframe
              srcDoc={previewHtml}
              className="w-full h-full rounded-lg shadow-xl border bg-white mx-auto"
              style={{ maxWidth: '900px', display: 'block', margin: '0 auto' }}
              title="Report Preview"
              sandbox="allow-same-origin"
            />
          </div>
        </div>
      )}
    </AppLayout>
  );
}

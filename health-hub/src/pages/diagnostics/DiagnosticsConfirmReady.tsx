import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import { ArrowLeft, CheckCircle2, Loader2, MessageCircle, Printer } from 'lucide-react';

type BillItem = {
  id: string;
  name: string;
  code: string;
  price: number;
};

type VisitDetail = {
  id: string;
  billNumber: string;
  status: string;
  nextAction?: 'ENTER_RESULTS' | 'CONFIRM_READY' | 'NONE';
  hasReportableOrders?: boolean;
  hasBillOnlyOrders?: boolean;
  patient: {
    name: string;
    phone?: string | null;
    identifiers?: Array<{ type: string; value: string }>;
  };
  billItems?: BillItem[];
  createdAt: string;
};

export default function DiagnosticsConfirmReady() {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();

  const [visit, setVisit] = useState<VisitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const fetchVisit = async () => {
      if (!visitId || !token || !activeBranchId) return;

      try {
        setLoading(true);
        const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        });

        if (!response.ok) {
          throw new Error('Failed to load visit');
        }

        setVisit(await response.json());
      } catch (error) {
        console.error('Failed to load bill-only visit:', error);
        toast.error('Failed to load visit');
        setVisit(null);
      } finally {
        setLoading(false);
      }
    };

    fetchVisit();
  }, [visitId, token, activeBranchId]);

  const handleConfirmReady = async () => {
    if (!visitId) return;

    setConfirming(true);
    try {
      const response = await fetch(`${API_BASE}/visits/diagnostic/${visitId}/confirm-ready`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId || '',
        },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || 'Failed to confirm report readiness');
      }

      toast.success('Visit marked ready for collection');

      const refreshResponse = await fetch(`${API_BASE}/visits/diagnostic/${visitId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId || '',
        },
      });

      if (refreshResponse.ok) {
        setVisit(await refreshResponse.json());
      }
    } catch (error: any) {
      console.error('Failed to confirm report readiness:', error);
      toast.error(error.message || 'Failed to confirm report readiness');
    } finally {
      setConfirming(false);
    }
  };

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
          <p className="text-muted-foreground">Visit not found.</p>
          <Button className="mt-4" onClick={() => navigate('/diagnostics/pending')}>
            Back to Pending Queue
          </Button>
        </div>
      </AppLayout>
    );
  }

  const patientPhone =
    visit.patient.identifiers?.find((identifier) => identifier.type === 'PHONE')?.value || '';
  const isBillOnly = visit.hasBillOnlyOrders && !visit.hasReportableOrders;
  const isCompleted = visit.status === 'COMPLETED';

  if (!isBillOnly) {
    return (
      <AppLayout context="diagnostics">
        <div className="max-w-2xl mx-auto space-y-6">
          <Card>
            <CardContent className="pt-6 space-y-4">
              <p className="text-muted-foreground">
                This visit is not a pure bill-only case. Use the standard result entry workflow instead.
              </p>
              <div className="flex gap-3">
                <Button variant="outline" onClick={() => navigate('/diagnostics/pending')}>
                  Back to Pending Queue
                </Button>
                <Button onClick={() => navigate(`/diagnostics/results/${visit.id}`)}>
                  Go to Result Entry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="diagnostics">
      <div className="max-w-3xl mx-auto space-y-6 animate-fade-in">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/diagnostics/pending')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Confirm Report Ready</h1>
            <p className="text-muted-foreground">Complete this bill-only visit and send the collection notice.</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <CardTitle>{visit.patient.name}</CardTitle>
              <StatusBadge status={visit.status} />
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Bill Number</p>
                <p className="font-mono font-semibold">{visit.billNumber}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Patient Phone</p>
                <p className="font-medium">{patientPhone || 'No primary phone on file'}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Visit Date</p>
                <p>{new Date(visit.createdAt).toLocaleString('en-IN')}</p>
              </div>
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">WhatsApp Completion Message</p>
                <p className="flex items-center gap-2">
                  <MessageCircle className="h-4 w-4 text-green-600" />
                  {isCompleted
                    ? 'Already sent or ready to resend manually'
                    : 'bill_only_collection_notice will be sent after confirmation'}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <h2 className="font-semibold">Ordered Bill-Only Items</h2>
              {visit.billItems?.length ? (
                <div className="rounded-lg border divide-y">
                  {visit.billItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between px-4 py-3">
                      <div>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{item.code}</p>
                      </div>
                      <p className="font-semibold">₹{item.price.toLocaleString('en-IN')}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No bill items found.</p>
              )}
            </div>

            {isCompleted ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 mt-0.5" />
                  <div className="space-y-3">
                    <p className="font-medium">This bill-only visit is already completed.</p>
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <Button variant="outline" onClick={() => navigate('/diagnostics/pending')}>
                        Back to Pending Queue
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => window.open(`/bill/print/DIAGNOSTICS/${visit.id}`, '_blank')}
                      >
                        <Printer className="mr-2 h-4 w-4" />
                        Print Bill
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row">
                <Button variant="outline" onClick={() => navigate('/diagnostics/pending')}>
                  Cancel
                </Button>
                <Button onClick={handleConfirmReady} disabled={confirming} className="sm:flex-1">
                  {confirming ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {confirming ? 'Confirming...' : 'Confirm Report Ready'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

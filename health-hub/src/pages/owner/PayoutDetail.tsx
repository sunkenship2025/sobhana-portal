import { useState, useEffect, useMemo } from 'react';
import { API_BASE } from '@/lib/api';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Calendar,
  Check,
  Clock,
  CreditCard,
  Download,
  FileText,
  IndianRupee,
  Printer,
  Search,
  Trash2,
  User
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PayoutDetail as PayoutDetailType, PaymentType } from '@/types';
import { formatRupees } from '@/lib/payoutFormatters';
import { formatReferralPayout } from '@/lib/referralPayouts';
import { formatPatientName } from '@/lib/patientDisplay';
import { PayoutMarkPaidDialog } from '@/components/payouts/PayoutMarkPaidDialog';
import { PayoutDeleteDialog } from '@/components/payouts/PayoutDeleteDialog';

// Helper to format date
const formatDate = (dateStr: string | null): string => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

// Helper to format period
const formatPeriod = (start: string, end: string): string => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  return `${startDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} - ${endDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
};

const formatCommissionValue = (item: PayoutDetailType['lineItems'][number]): string => {
  if (item.commissionLabel) return item.commissionLabel;

  if (
    !item.commissionType &&
    item.commissionPercentage == null &&
    item.commissionAmountInPaise == null
  ) {
    return '-';
  }

  return formatReferralPayout({
    commissionType: item.commissionType,
    commissionPercent: item.commissionPercentage,
    commissionAmountInPaise: item.commissionAmountInPaise,
  });
};

const PayoutDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();

  // State
  const [payout, setPayout] = useState<PayoutDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [paying, setPaying] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lineItemSearch, setLineItemSearch] = useState('');

  // Fetch payout detail
  const fetchPayout = async () => {
    if (!token || !id || !activeBranchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setPayout(data.data);
      } else if (res.status === 404) {
        toast.error('Payout not found');
        navigate('/owner/payouts');
      } else {
        toast.error('Failed to fetch payout details');
      }
    } catch (err) {
      console.error('Error fetching payout:', err);
      toast.error('Error fetching payout details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayout();
  }, [token, id, activeBranchId]);

  const handleMarkPaid = async (payment: {
    paymentMethod: PaymentType;
    paymentReferenceId?: string;
    notes?: string;
  }) => {
    if (!id || !activeBranchId) return;
    setPaying(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
        body: JSON.stringify(payment),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success('Payout marked as paid');
        setShowPayDialog(false);
        setPayout(data.data);
      } else if (res.status === 409) {
        toast.error('This payout has already been paid');
        fetchPayout();
      } else {
        toast.error(data.message || 'Failed to mark payout as paid');
      }
    } catch (err) {
      console.error('Error marking payout as paid:', err);
      toast.error('Error marking payout as paid');
    } finally {
      setPaying(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !activeBranchId) return;
    setDeleting(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success('Payout deleted');
        navigate('/owner/payouts');
      } else {
        toast.error(data.message || 'Failed to delete payout');
      }
    } catch (err) {
      console.error('Error deleting payout:', err);
      toast.error('Error deleting payout');
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const handleExport = async () => {
    if (!id || !activeBranchId) return;
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}/export`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
      });
      if (!res.ok) {
        toast.error('Failed to export');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = (payout?.doctorName || 'payout').replace(/\s+/g, '_');
      a.download = `payout-${safeName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error('Error exporting payout');
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <AppLayout context="owner" subContext="payouts">
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Loading payout details...</p>
        </div>
      </AppLayout>
    );
  }

  if (!payout) {
    return (
      <AppLayout context="owner" subContext="payouts">
        <div className="flex items-center justify-center h-64">
          <p className="text-muted-foreground">Payout not found</p>
        </div>
      </AppLayout>
    );
  }

  const canMarkPaid = !payout.paidAt && (user?.role === 'owner' || user?.role === 'staff');
  const canDelete = user?.role === 'owner';
  const showsCommission = payout.doctorType !== 'CLINIC';

  const filteredLineItems = useMemo(() => {
    if (!lineItemSearch.trim()) return payout.lineItems;
    const q = lineItemSearch.trim().toLowerCase();
    return payout.lineItems.filter(
      (li) =>
        li.billNumber.toLowerCase().includes(q) ||
        li.patientName.toLowerCase().includes(q) ||
        li.testOrFee.toLowerCase().includes(q)
    );
  }, [payout.lineItems, lineItemSearch]);

  return (
    <AppLayout context="owner" subContext="payouts">
      <div className="print-content space-y-6 print:p-4">
        {/* Header */}
        <div className="flex items-center justify-between print:hidden">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/owner/payouts')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Payout Details</h1>
              <p className="text-muted-foreground">{payout.doctorName} • {formatPeriod(payout.periodStartDate, payout.periodEndDate)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              Export Excel
            </Button>
            <Button variant="outline" onClick={handlePrint}>
              <Printer className="h-4 w-4 mr-2" />
              Print
            </Button>
            {canMarkPaid && (
              <Button onClick={() => setShowPayDialog(true)}>
                <CreditCard className="h-4 w-4 mr-2" />
                Mark as Paid
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                onClick={() => setShowDeleteDialog(true)}
                className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </Button>
            )}
          </div>
        </div>

        {/* Print Header */}
        <div className="hidden print:block space-y-1">
          <h1 className="text-xl font-semibold">Payout Statement</h1>
          <p className="text-sm text-foreground">
            {payout.doctorName} ({payout.doctorType}) | {formatPeriod(payout.periodStartDate, payout.periodEndDate)}
          </p>
          <p className="text-sm text-foreground">
            Branch: {payout.branchName} | Status: {payout.paidAt ? `Paid on ${formatDate(payout.paidAt)}` : 'Pending'}
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4 print:hidden">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <User className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Doctor</p>
                  <p className="font-semibold">{payout.doctorName}</p>
                  <Badge variant={payout.doctorType === 'REFERRAL' ? 'default' : 'secondary'} className="mt-1">
                    {payout.doctorType}
                  </Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <Calendar className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Period</p>
                  <p className="font-semibold">{formatPeriod(payout.periodStartDate, payout.periodEndDate)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <IndianRupee className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Amount</p>
                  <p className="text-xl font-bold text-green-700">{formatRupees(payout.derivedAmountInPaise)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                {payout.paidAt ? (
                  <>
                    <div className="p-2 bg-green-100 rounded-lg">
                      <Check className="h-5 w-5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Status</p>
                      <p className="font-semibold text-green-700">Paid</p>
                      <p className="text-xs text-muted-foreground">{formatDate(payout.paidAt)}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-2 bg-yellow-100 rounded-lg">
                      <Clock className="h-5 w-5 text-yellow-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Status</p>
                      <p className="font-semibold text-yellow-700">Pending</p>
                    </div>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Payment Details (if paid) */}
        {payout.paidAt && (
          <Card className="print:hidden">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Payment Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Payment Method</p>
                  <p className="font-medium">{payout.paymentMethod}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Paid On</p>
                  <p className="font-medium">{formatDate(payout.paidAt)}</p>
                </div>
                {payout.paymentReferenceId && (
                  <div>
                    <p className="text-sm text-muted-foreground">Reference ID</p>
                    <p className="font-medium">{payout.paymentReferenceId}</p>
                  </div>
                )}
                {payout.notes && (
                  <div className="col-span-2">
                    <p className="text-sm text-muted-foreground">Notes</p>
                    <p className="font-medium">{payout.notes}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Line Items Table */}
        <Card className="print:rounded-none print:border-0 print:shadow-none">
          <CardHeader className="print:px-0 print:pt-0 print:pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5 print:hidden" />
              Line Items ({payout.lineItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="print:px-0 print:pb-0">
            {/* Line-item search */}
            {payout.lineItems.length > 0 && (
              <div className="relative max-w-sm mb-4 print:hidden">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="Search bill #, patient, product…"
                  value={lineItemSearch}
                  onChange={(e) => setLineItemSearch(e.target.value)}
                />
              </div>
            )}
            {filteredLineItems.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {lineItemSearch
                  ? 'No line items match your search.'
                  : 'No line items found for this period.'}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Bill #</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>{payout.doctorType === 'CLINIC' ? 'Service' : 'Billable Product'}</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {showsCommission && (
                      <TableHead className="text-right">Commission</TableHead>
                    )}
                    <TableHead className="text-right">Derived</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredLineItems.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>{formatDate(item.date)}</TableCell>
                      <TableCell className="font-mono text-sm">{item.billNumber}</TableCell>
                      <TableCell>{formatPatientName(item.patientName, item.patientTitle)}</TableCell>
                      <TableCell>{item.testOrFee}</TableCell>
                      <TableCell className="text-right">{formatRupees(item.amountInPaise)}</TableCell>
                      {showsCommission && (
                        <TableCell className="text-right">
                          {formatCommissionValue(item)}
                        </TableCell>
                      )}
                      <TableCell className="text-right font-semibold">
                        {formatRupees(item.derivedCommissionInPaise)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* Totals */}
            <Separator className="my-4 print:hidden" />
            <div className="flex justify-end">
              <div className="text-right space-y-2">
                <div className="flex justify-between gap-12">
                  <span className="text-muted-foreground">Total Items:</span>
                  <span className="font-medium">{payout.lineItems.length}</span>
                </div>
                <div className="flex justify-between gap-12 text-lg">
                  <span className="font-medium">Total Payout:</span>
                  <span className="font-bold text-green-700">{formatRupees(payout.derivedAmountInPaise)}</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Metadata */}
        <Card className="print:hidden">
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
              <div>
                <span className="font-medium">Derived At:</span> {formatDate(payout.derivedAt)}
              </div>
              <div>
                <span className="font-medium">Branch:</span> {payout.branchName}
              </div>
              <div>
                <span className="font-medium">Payout ID:</span> <span className="font-mono">{payout.id}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <PayoutMarkPaidDialog
        open={showPayDialog}
        onOpenChange={setShowPayDialog}
        busy={paying}
        payout={payout}
        onConfirm={handleMarkPaid}
      />

      {canDelete && (
        <PayoutDeleteDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
          count={1}
          busy={deleting}
          onConfirm={handleDelete}
        />
      )}
    </AppLayout>
  );
};

export default PayoutDetailPage;

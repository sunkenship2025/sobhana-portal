import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuthStore } from '@/store/authStore';
import { toast } from 'sonner';
import { 
  ArrowLeft, 
  Calendar, 
  Check, 
  Clock, 
  CreditCard, 
  FileText,
  IndianRupee,
  Printer,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PayoutDetail as PayoutDetailType, PaymentType } from '@/types';

// Helper to format amount in Rupees
const formatRupees = (paise: number): string => {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
};

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

const PayoutDetailPage = () => {
  const { id } = useParams<{ id: string }>();
  const { token, user } = useAuthStore();
  const navigate = useNavigate();

  // State
  const [payout, setPayout] = useState<PayoutDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [paying, setPaying] = useState(false);

  // Mark paid form
  const [payForm, setPayForm] = useState({
    paymentMethod: 'CASH' as PaymentType,
    paymentReferenceId: '',
    notes: '',
  });

  // Fetch payout detail
  const fetchPayout = async () => {
    if (!token || !id) return;
    setLoading(true);
    try {
      const res = await fetch(`http://localhost:3000/api/payouts/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
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
  }, [token, id]);

  // Mark as paid
  const handleMarkPaid = async () => {
    if (!id) return;
    setPaying(true);
    try {
      const res = await fetch(`http://localhost:3000/api/payouts/${id}/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          paymentMethod: payForm.paymentMethod,
          paymentReferenceId: payForm.paymentReferenceId || undefined,
          notes: payForm.notes || undefined,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success('Payout marked as paid successfully');
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

  // Print functionality
  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <AppLayout context="owner" subContext="payouts">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Loading payout details...</p>
        </div>
      </AppLayout>
    );
  }

  if (!payout) {
    return (
      <AppLayout context="owner" subContext="payouts">
        <div className="flex items-center justify-center h-64">
          <p className="text-gray-500">Payout not found</p>
        </div>
      </AppLayout>
    );
  }

  const canMarkPaid = !payout.paidAt && (user?.role === 'owner' || user?.role === 'staff');

  return (
    <AppLayout context="owner" subContext="payouts">
      <div className="space-y-6 print:p-4">
        {/* Header */}
        <div className="flex items-center justify-between print:hidden">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate('/owner/payouts')}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Payout Details</h1>
              <p className="text-gray-500">{payout.doctorName} • {formatPeriod(payout.periodStartDate, payout.periodEndDate)}</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
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
          </div>
        </div>

        {/* Print Header */}
        <div className="hidden print:block mb-8">
          <h1 className="text-2xl font-bold text-center">Sobhana Portal</h1>
          <h2 className="text-xl text-center mt-2">Payout Statement</h2>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <User className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Doctor</p>
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
                  <p className="text-sm text-gray-500">Period</p>
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
                  <p className="text-sm text-gray-500">Total Amount</p>
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
                      <p className="text-sm text-gray-500">Status</p>
                      <p className="font-semibold text-green-700">Paid</p>
                      <p className="text-xs text-gray-500">{formatDate(payout.paidAt)}</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-2 bg-yellow-100 rounded-lg">
                      <Clock className="h-5 w-5 text-yellow-600" />
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Status</p>
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
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Payment Details
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-sm text-gray-500">Payment Method</p>
                  <p className="font-medium">{payout.paymentMethod}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-500">Paid On</p>
                  <p className="font-medium">{formatDate(payout.paidAt)}</p>
                </div>
                {payout.paymentReferenceId && (
                  <div>
                    <p className="text-sm text-gray-500">Reference ID</p>
                    <p className="font-medium">{payout.paymentReferenceId}</p>
                  </div>
                )}
                {payout.notes && (
                  <div className="col-span-2">
                    <p className="text-sm text-gray-500">Notes</p>
                    <p className="font-medium">{payout.notes}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Line Items Table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Line Items ({payout.lineItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {payout.lineItems.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No line items found for this period.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Bill #</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead>{payout.doctorType === 'REFERRAL' ? 'Test' : 'Service'}</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    {payout.doctorType === 'REFERRAL' && (
                      <TableHead className="text-right">Commission %</TableHead>
                    )}
                    <TableHead className="text-right">Derived</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payout.lineItems.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>{formatDate(item.date)}</TableCell>
                      <TableCell className="font-mono text-sm">{item.billNumber}</TableCell>
                      <TableCell>{item.patientName}</TableCell>
                      <TableCell>{item.testOrFee}</TableCell>
                      <TableCell className="text-right">{formatRupees(item.amountInPaise)}</TableCell>
                      {payout.doctorType === 'REFERRAL' && (
                        <TableCell className="text-right">{item.commissionPercentage}%</TableCell>
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
            <Separator className="my-4" />
            <div className="flex justify-end">
              <div className="text-right space-y-2">
                <div className="flex justify-between gap-12">
                  <span className="text-gray-500">Total Items:</span>
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
            <div className="flex flex-wrap gap-6 text-sm text-gray-500">
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

      {/* Mark Paid Dialog */}
      <Dialog open={showPayDialog} onOpenChange={setShowPayDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark Payout as Paid</DialogTitle>
            <DialogDescription>
              This action is <strong>permanent</strong>. Once marked as paid, this payout cannot be modified.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="flex justify-between">
                <span className="text-gray-600">Doctor:</span>
                <span className="font-medium">{payout.doctorName}</span>
              </div>
              <div className="flex justify-between mt-2">
                <span className="text-gray-600">Amount:</span>
                <span className="font-bold text-green-700">{formatRupees(payout.derivedAmountInPaise)}</span>
              </div>
            </div>

            <div>
              <Label>Payment Method *</Label>
              <Select 
                value={payForm.paymentMethod} 
                onValueChange={(v) => setPayForm(prev => ({ ...prev, paymentMethod: v as PaymentType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="ONLINE">Online Transfer</SelectItem>
                  <SelectItem value="CHEQUE">Cheque</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Reference ID (Optional)</Label>
              <Input
                placeholder={payForm.paymentMethod === 'CHEQUE' ? 'Cheque number' : 'Transaction ID'}
                value={payForm.paymentReferenceId}
                onChange={(e) => setPayForm(prev => ({ ...prev, paymentReferenceId: e.target.value }))}
              />
            </div>

            <div>
              <Label>Notes (Optional)</Label>
              <Textarea
                placeholder="Any additional notes about this payment"
                value={payForm.notes}
                onChange={(e) => setPayForm(prev => ({ ...prev, notes: e.target.value }))}
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPayDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleMarkPaid} disabled={paying}>
              {paying ? 'Processing...' : 'Confirm Payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default PayoutDetailPage;

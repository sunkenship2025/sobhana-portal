import { useState, useEffect, useMemo } from 'react';
import { API_BASE } from '@/lib/api';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { toast } from 'sonner';
import { 
  ArrowUpDown, 
  Calculator, 
  Check, 
  Clock, 
  Filter, 
  IndianRupee,
  ChevronLeft,
  ChevronRight
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
import { PayoutSummary, PayoutDoctorType, PaymentType } from '@/types';

// Helper to format amount in Rupees
const formatRupees = (paise: number): string => {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
};

// Helper to format date
const formatDate = (dateStr: string): string => {
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
  const startLabel = startDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const endLabel = endDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
};

const isCoveredByAnotherPayout = (candidate: PayoutSummary, covering: PayoutSummary): boolean => {
  if (candidate.id === covering.id) return false;
  if (candidate.branchId !== covering.branchId) return false;
  if (candidate.doctorType !== covering.doctorType) return false;
  if (candidate.doctorId !== covering.doctorId) return false;

  return (
    new Date(candidate.periodStartDate).getTime() >= new Date(covering.periodStartDate).getTime() &&
    new Date(candidate.periodEndDate).getTime() <= new Date(covering.periodEndDate).getTime()
  );
};

const PayoutsList = () => {
  const { token, user } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();

  // State
  const [payouts, setPayouts] = useState<PayoutSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeriveDialog, setShowDeriveDialog] = useState(false);
  const [deriving, setDeriving] = useState(false);

  // Filters
  const [doctorTypeFilter, setDoctorTypeFilter] = useState<string>('all');
  const [doctorFilter, setDoctorFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [startDateFilter, setStartDateFilter] = useState('');
  const [endDateFilter, setEndDateFilter] = useState('');
  
  // Derive form state
  const defaultDeriveStartDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const defaultDeriveEndDate = new Date().toISOString().slice(0, 10);
  const [deriveForm, setDeriveForm] = useState({
    doctorType: 'REFERRAL' as PayoutDoctorType,
    doctorId: '',
    startDate: defaultDeriveStartDate,
    endDate: defaultDeriveEndDate,
  });

  const [showPayDialog, setShowPayDialog] = useState(false);
  const [paying, setPaying] = useState(false);
  const [selectedPayoutForPay, setSelectedPayoutForPay] = useState<PayoutSummary | null>(null);
  const [payForm, setPayForm] = useState({
    paymentMethod: 'CASH' as PaymentType,
    paymentReferenceId: '',
    notes: '',
  });

  // Doctors for dropdown
  const [referralDoctors, setReferralDoctors] = useState<any[]>([]);
  const [clinicDoctors, setClinicDoctors] = useState<any[]>([]);
  const [diagnosticCenters, setDiagnosticCenters] = useState<any[]>([]);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // Sort
  const [sortField, setSortField] = useState<'derivedAt' | 'doctorName' | 'amount'>('derivedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Fetch payouts
  const fetchPayouts = async () => {
    if (!token || !activeBranchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      let url = `${API_BASE}/payouts`;
      const params = new URLSearchParams();
      if (doctorTypeFilter !== 'all') {
        params.append('doctorType', doctorTypeFilter);
      }
      if (doctorFilter !== 'all') {
        params.append('doctorId', doctorFilter);
      }
      if (statusFilter !== 'all') {
        params.append('isPaid', statusFilter === 'paid' ? 'true' : 'false');
      }
      if (startDateFilter) {
        params.append('startDate', startDateFilter);
      }
      if (endDateFilter) {
        params.append('endDate', endDateFilter);
      }
      if (params.toString()) {
        url += `?${params.toString()}`;
      }

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setPayouts(data.data || []);
      } else {
        toast.error('Failed to fetch payouts');
      }
    } catch (err) {
      console.error('Error fetching payouts:', err);
      toast.error('Error fetching payouts');
    } finally {
      setLoading(false);
    }
  };

  // Fetch doctors for dropdown
  const fetchDoctors = async () => {
    if (!token || !activeBranchId) return;
    try {
      const [refRes, clinicRes, dcRes] = await Promise.all([
        fetch(`${API_BASE}/payouts/doctors/referral`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        }),
        fetch(`${API_BASE}/payouts/doctors/clinic`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        }),
        fetch(`${API_BASE}/payouts/doctors/diagnostic-centers`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-Branch-Id': activeBranchId,
          },
        }),
      ]);

      if (refRes.ok) {
        const data = await refRes.json();
        setReferralDoctors(data.data || []);
      }
      if (clinicRes.ok) {
        const data = await clinicRes.json();
        setClinicDoctors(data.data || []);
      }
      if (dcRes.ok) {
        const data = await dcRes.json();
        setDiagnosticCenters(data.data || []);
      }
    } catch (err) {
      console.error('Error fetching doctors:', err);
    }
  };

  useEffect(() => {
    fetchPayouts();
    fetchDoctors();
  }, [token, activeBranchId, doctorTypeFilter, doctorFilter, statusFilter, startDateFilter, endDateFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [doctorTypeFilter, doctorFilter, statusFilter, startDateFilter, endDateFilter]);

  // Sorted and filtered payouts
  const sortedPayouts = useMemo(() => {
    const sorted = [...payouts].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'derivedAt':
          comparison = new Date(a.derivedAt).getTime() - new Date(b.derivedAt).getTime();
          break;
        case 'doctorName':
          comparison = a.doctorName.localeCompare(b.doctorName);
          break;
        case 'amount':
          comparison = a.derivedAmountInPaise - b.derivedAmountInPaise;
          break;
      }
      return sortDir === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [payouts, sortField, sortDir]);

  // Paginated payouts
  const paginatedPayouts = useMemo(() => {
    const startIndex = (currentPage - 1) * itemsPerPage;
    return sortedPayouts.slice(startIndex, startIndex + itemsPerPage);
  }, [sortedPayouts, currentPage]);

  const totalPages = Math.ceil(sortedPayouts.length / itemsPerPage);

  // Summary calculations
  const canonicalPayouts = useMemo(
    () => payouts.filter((payout) => !payouts.some((other) => isCoveredByAnotherPayout(payout, other))),
    [payouts]
  );

  const summary = useMemo(() => {
    const pending = canonicalPayouts.filter(p => !p.paidAt);
    const paid = canonicalPayouts.filter(p => p.paidAt);
    return {
      totalPending: pending.reduce((sum, p) => sum + p.derivedAmountInPaise, 0),
      totalPaid: paid.reduce((sum, p) => sum + p.derivedAmountInPaise, 0),
      pendingCount: pending.length,
      paidCount: paid.length,
    };
  }, [canonicalPayouts]);

  // Handle sort toggle
  const toggleSort = (field: 'derivedAt' | 'doctorName' | 'amount') => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // Derive payout
  const handleDerive = async () => {
    if (!token || !activeBranchId) return;

    if (!deriveForm.doctorId) {
      toast.error('Please select a doctor');
      return;
    }

    if (!deriveForm.startDate || !deriveForm.endDate) {
      toast.error('Please select a start and end date');
      return;
    }

    setDeriving(true);
    try {
      const startDate = new Date(`${deriveForm.startDate}T00:00:00`);
      const endDate = new Date(`${deriveForm.endDate}T23:59:59.999`);

      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
        toast.error('Please enter a valid date range');
        return;
      }

      if (startDate > endDate) {
        toast.error('Start date must be before end date');
        return;
      }

      const res = await fetch(`${API_BASE}/payouts/derive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
        },
        body: JSON.stringify({
          doctorType: deriveForm.doctorType,
          doctorId: deriveForm.doctorId,
          periodStartDate: startDate.toISOString(),
          periodEndDate: endDate.toISOString(),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        toast.success(data.isNew ? 'Payout derived successfully' : 'Existing payout found');
        setShowDeriveDialog(false);
        fetchPayouts();
        // Navigate to detail view
        navigate(`/owner/payouts/${data.data.id}`);
      } else {
        toast.error(data.message || 'Failed to derive payout');
      }
    } catch (err) {
      console.error('Error deriving payout:', err);
      toast.error('Error deriving payout');
    } finally {
      setDeriving(false);
    }
  };

  // Available doctors based on selected type
  const availableDoctors = deriveForm.doctorType === 'REFERRAL'
    ? referralDoctors
    : deriveForm.doctorType === 'CLINIC'
    ? clinicDoctors
    : diagnosticCenters;

  const filterDoctorOptions = useMemo(() => {
    if (doctorTypeFilter === 'REFERRAL') {
      return referralDoctors.map((doc) => ({ id: doc.id, name: doc.name }));
    }
    if (doctorTypeFilter === 'CLINIC') {
      return clinicDoctors.map((doc) => ({ id: doc.id, name: doc.name }));
    }
    if (doctorTypeFilter === 'DIAGNOSTIC_CENTER') {
      return diagnosticCenters.map((doc) => ({ id: doc.id, name: doc.name }));
    }

    return [
      ...referralDoctors.map((doc) => ({ id: doc.id, name: `${doc.name} (Referral)` })),
      ...clinicDoctors.map((doc) => ({ id: doc.id, name: `${doc.name} (Clinic)` })),
      ...diagnosticCenters.map((doc) => ({ id: doc.id, name: `${doc.name} (Center)` })),
    ];
  }, [doctorTypeFilter, referralDoctors, clinicDoctors, diagnosticCenters]);

  // Reset doctor selection when type changes
  useEffect(() => {
    setDeriveForm(prev => ({ ...prev, doctorId: '' }));
  }, [deriveForm.doctorType]);

  useEffect(() => {
    setDoctorFilter('all');
  }, [doctorTypeFilter]);

  const handleOpenMarkPaid = (payout: PayoutSummary) => {
    setSelectedPayoutForPay(payout);
    setPayForm({
      paymentMethod: 'CASH',
      paymentReferenceId: '',
      notes: '',
    });
    setShowPayDialog(true);
  };

  const handleMarkPaid = async () => {
    if (!token || !activeBranchId || !selectedPayoutForPay) return;

    setPaying(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${selectedPayoutForPay.id}/mark-paid`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Branch-Id': activeBranchId,
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
        setSelectedPayoutForPay(null);
        await fetchPayouts();
      } else if (res.status === 409) {
        toast.error('This payout has already been paid');
        await fetchPayouts();
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

  return (
    <AppLayout context="owner" subContext="payouts">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
            <p className="text-gray-500">Manage commissions for referral doctors, clinic doctors, and diagnostic centers</p>
          </div>
          
          {(user?.role === 'owner' || user?.role === 'staff') && (
            <Button onClick={() => setShowDeriveDialog(true)}>
              <Calculator className="h-4 w-4 mr-2" />
              Derive Payout
            </Button>
          )}
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-yellow-100 rounded-lg">
                  <Clock className="h-5 w-5 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Pending Payouts</p>
                  <p className="text-xl font-semibold">{summary.pendingCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-lg">
                  <IndianRupee className="h-5 w-5 text-red-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Pending Amount</p>
                  <p className="text-xl font-semibold">{formatRupees(summary.totalPending)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Check className="h-5 w-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Paid Payouts</p>
                  <p className="text-xl font-semibold">{summary.paidCount}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <IndianRupee className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Total Paid</p>
                  <p className="text-xl font-semibold">{formatRupees(summary.totalPaid)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4" />
              <CardTitle className="text-lg">Filters</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-4">
              <div className="w-48">
                <Label>Doctor Type</Label>
                <Select value={doctorTypeFilter} onValueChange={setDoctorTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="REFERRAL">Referral Doctors</SelectItem>
                    <SelectItem value="CLINIC">Clinic Doctors</SelectItem>
                    <SelectItem value="DIAGNOSTIC_CENTER">Diagnostic Centers</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-56">
                <Label>Doctor / Center</Label>
                <Select value={doctorFilter} onValueChange={setDoctorFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Doctors / Centers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Doctors / Centers</SelectItem>
                    {filterDoctorOptions.map((doctor) => (
                      <SelectItem key={doctor.id} value={doctor.id}>
                        {doctor.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="w-48">
                <Label>Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="paid">Paid</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="w-44">
                <Label>Date From</Label>
                <Input
                  type="date"
                  value={startDateFilter}
                  onChange={(e) => setStartDateFilter(e.target.value)}
                />
              </div>

              <div className="w-44">
                <Label>Date To</Label>
                <Input
                  type="date"
                  value={endDateFilter}
                  onChange={(e) => setEndDateFilter(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Payouts Table */}
        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="text-center py-8 text-gray-500">Loading payouts...</div>
            ) : sortedPayouts.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                No payouts found for the selected filters. Use "Derive Payout" to calculate a doctor or center payout for a date range.
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => toggleSort('doctorName')}
                          className="h-auto p-0 font-medium"
                        >
                          Doctor
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => toggleSort('amount')}
                          className="h-auto p-0 font-medium"
                        >
                          Amount
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => toggleSort('derivedAt')}
                          className="h-auto p-0 font-medium"
                        >
                          Derived At
                          <ArrowUpDown className="ml-2 h-4 w-4" />
                        </Button>
                      </TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {paginatedPayouts.map((payout) => (
                      <TableRow key={payout.id}>
                        <TableCell className="font-medium">{payout.doctorName}</TableCell>
                        <TableCell>
                          <Badge variant={payout.doctorType === 'REFERRAL' ? 'default' : payout.doctorType === 'CLINIC' ? 'secondary' : 'outline'}>
                            {payout.doctorType === 'DIAGNOSTIC_CENTER' ? 'DC' : payout.doctorType}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatPeriod(payout.periodStartDate, payout.periodEndDate)}</TableCell>
                        <TableCell className="font-semibold">{formatRupees(payout.derivedAmountInPaise)}</TableCell>
                        <TableCell>
                          {payout.paidAt ? (
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                              <Check className="h-3 w-3 mr-1" />
                              Paid
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                              <Clock className="h-3 w-3 mr-1" />
                              Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-gray-500">{formatDate(payout.derivedAt)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Button 
                              variant="outline" 
                              size="sm"
                              onClick={() => navigate(`/owner/payouts/${payout.id}`)}
                            >
                              View Details
                            </Button>
                            {!payout.paidAt && (
                              <Button
                                size="sm"
                                onClick={() => handleOpenMarkPaid(payout)}
                              >
                                Mark Paid
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-4 pt-4 border-t">
                    <p className="text-sm text-gray-500">
                      Showing {((currentPage - 1) * itemsPerPage) + 1} to {Math.min(currentPage * itemsPerPage, sortedPayouts.length)} of {sortedPayouts.length}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-sm">
                        Page {currentPage} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Derive Payout Dialog */}
      <Dialog open={showDeriveDialog} onOpenChange={setShowDeriveDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Derive New Payout</DialogTitle>
            <DialogDescription>
              Calculate payout for a doctor based on finalized visits in the selected period.
            </DialogDescription>
          </DialogHeader>

            <div className="space-y-4">
            <div>
              <Label>Doctor Type</Label>
              <Select 
                value={deriveForm.doctorType} 
                onValueChange={(v) => setDeriveForm(prev => ({ ...prev, doctorType: v as PayoutDoctorType }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="REFERRAL">Referral Doctor</SelectItem>
                  <SelectItem value="CLINIC">Clinic Doctor</SelectItem>
                  <SelectItem value="DIAGNOSTIC_CENTER">Diagnostic Center</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 mt-1">
                {deriveForm.doctorType === 'REFERRAL'
                  ? 'Commission on diagnostic tests from finalized reports'
                  : deriveForm.doctorType === 'CLINIC'
                  ? 'Consultation fees from completed clinic visits'
                  : 'Commission for diagnostic center on finalized visits'}
              </p>
            </div>

            <div>
              <Label>Doctor</Label>
              <Select 
                value={deriveForm.doctorId} 
                onValueChange={(v) => setDeriveForm(prev => ({ ...prev, doctorId: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a doctor" />
                </SelectTrigger>
                <SelectContent>
                  {availableDoctors.map((doc) => (
                    <SelectItem key={doc.id} value={doc.id}>
                      {doc.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={deriveForm.startDate}
                  onChange={(e) => setDeriveForm(prev => ({ ...prev, startDate: e.target.value }))}
                />
              </div>
              <div>
                <Label>End Date</Label>
                <Input
                  type="date"
                  value={deriveForm.endDate}
                  onChange={(e) => setDeriveForm(prev => ({ ...prev, endDate: e.target.value }))}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeriveDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleDerive}
              disabled={deriving || !deriveForm.doctorId || !deriveForm.startDate || !deriveForm.endDate}
            >
              {deriving ? 'Deriving...' : 'Derive Payout'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPayDialog} onOpenChange={setShowPayDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark Payout as Paid</DialogTitle>
            <DialogDescription>
              Confirm the payment details for this payout.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {selectedPayoutForPay && (
              <div className="rounded-lg bg-muted p-4 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Doctor / Center</span>
                  <span className="font-medium text-right">{selectedPayoutForPay.doctorName}</span>
                </div>
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-muted-foreground">Amount</span>
                  <span className="font-semibold">{formatRupees(selectedPayoutForPay.derivedAmountInPaise)}</span>
                </div>
              </div>
            )}

            <div>
              <Label>Payment Method</Label>
              <Select
                value={payForm.paymentMethod}
                onValueChange={(value) =>
                  setPayForm((prev) => ({ ...prev, paymentMethod: value as PaymentType }))
                }
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
              <Label>Reference ID</Label>
              <Input
                placeholder={payForm.paymentMethod === 'CHEQUE' ? 'Cheque number' : 'Transaction ID'}
                value={payForm.paymentReferenceId}
                onChange={(e) => setPayForm((prev) => ({ ...prev, paymentReferenceId: e.target.value }))}
              />
            </div>

            <div>
              <Label>Notes</Label>
              <Input
                placeholder="Optional notes"
                value={payForm.notes}
                onChange={(e) => setPayForm((prev) => ({ ...prev, notes: e.target.value }))}
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

export default PayoutsList;

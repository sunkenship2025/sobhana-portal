import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/authStore';
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
import { PayoutSummary, PayoutDoctorType } from '@/types';

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
  return `${startDate.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`;
};

const PayoutsList = () => {
  const { token, user } = useAuthStore();
  const navigate = useNavigate();

  // State
  const [payouts, setPayouts] = useState<PayoutSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeriveDialog, setShowDeriveDialog] = useState(false);
  const [deriving, setDeriving] = useState(false);

  // Filters
  const [doctorTypeFilter, setDoctorTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  
  // Derive form state
  const [deriveForm, setDeriveForm] = useState({
    doctorType: 'REFERRAL' as PayoutDoctorType,
    doctorId: '',
    month: new Date().getMonth(),
    year: new Date().getFullYear(),
  });

  // Doctors for dropdown
  const [referralDoctors, setReferralDoctors] = useState<any[]>([]);
  const [clinicDoctors, setClinicDoctors] = useState<any[]>([]);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 15;

  // Sort
  const [sortField, setSortField] = useState<'derivedAt' | 'doctorName' | 'amount'>('derivedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Fetch payouts
  const fetchPayouts = async () => {
    if (!token) return;
    setLoading(true);
    try {
      let url = 'http://localhost:3000/api/payouts';
      const params = new URLSearchParams();
      if (doctorTypeFilter !== 'all') {
        params.append('doctorType', doctorTypeFilter);
      }
      if (statusFilter !== 'all') {
        params.append('isPaid', statusFilter === 'paid' ? 'true' : 'false');
      }
      if (params.toString()) {
        url += `?${params.toString()}`;
      }

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
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
    if (!token) return;
    try {
      const [refRes, clinicRes] = await Promise.all([
        fetch('http://localhost:3000/api/payouts/doctors/referral', {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch('http://localhost:3000/api/payouts/doctors/clinic', {
          headers: { Authorization: `Bearer ${token}` },
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
    } catch (err) {
      console.error('Error fetching doctors:', err);
    }
  };

  useEffect(() => {
    fetchPayouts();
    fetchDoctors();
  }, [token, doctorTypeFilter, statusFilter]);

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
  const summary = useMemo(() => {
    const pending = payouts.filter(p => !p.paidAt);
    const paid = payouts.filter(p => p.paidAt);
    return {
      totalPending: pending.reduce((sum, p) => sum + p.derivedAmountInPaise, 0),
      totalPaid: paid.reduce((sum, p) => sum + p.derivedAmountInPaise, 0),
      pendingCount: pending.length,
      paidCount: paid.length,
    };
  }, [payouts]);

  // Handle sort toggle
  const toggleSort = (field: 'derivedAt' | 'doctorName' | 'amount') => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // Get period dates for derivation
  const getPeriodDates = () => {
    const year = deriveForm.year;
    const month = deriveForm.month;
    const startDate = new Date(year, month, 1);
    const endDate = new Date(year, month + 1, 0, 23, 59, 59, 999);
    return { startDate, endDate };
  };

  // Derive payout
  const handleDerive = async () => {
    if (!deriveForm.doctorId) {
      toast.error('Please select a doctor');
      return;
    }

    setDeriving(true);
    try {
      const { startDate, endDate } = getPeriodDates();

      const res = await fetch('http://localhost:3000/api/payouts/derive', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
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
  const availableDoctors = deriveForm.doctorType === 'REFERRAL' ? referralDoctors : clinicDoctors;

  // Reset doctor selection when type changes
  useEffect(() => {
    setDeriveForm(prev => ({ ...prev, doctorId: '' }));
  }, [deriveForm.doctorType]);

  // Month options
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  // Year options (last 2 years + current year)
  const currentYear = new Date().getFullYear();
  const years = [currentYear - 2, currentYear - 1, currentYear];

  return (
    <AppLayout context="owner" subContext="payouts">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Doctor Payouts</h1>
            <p className="text-gray-500">Manage referral commissions and clinic doctor fees</p>
          </div>
          
          {user?.role === 'owner' && (
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
                No payouts found. Click "Derive Payout" to calculate a new payout.
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
                          <Badge variant={payout.doctorType === 'REFERRAL' ? 'default' : 'secondary'}>
                            {payout.doctorType}
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
                          <Button 
                            variant="outline" 
                            size="sm"
                            onClick={() => navigate(`/owner/payouts/${payout.id}`)}
                          >
                            View Details
                          </Button>
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
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500 mt-1">
                {deriveForm.doctorType === 'REFERRAL' 
                  ? 'Commission on diagnostic tests from finalized reports'
                  : 'Consultation fees from completed clinic visits'}
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
                      {deriveForm.doctorType === 'REFERRAL' && doc.commissionPercent && (
                        <span className="text-gray-500 ml-2">({doc.commissionPercent}%)</span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Month</Label>
                <Select 
                  value={String(deriveForm.month)} 
                  onValueChange={(v) => setDeriveForm(prev => ({ ...prev, month: parseInt(v) }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {months.map((month, idx) => (
                      <SelectItem key={idx} value={String(idx)}>{month}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Year</Label>
                <Select 
                  value={String(deriveForm.year)} 
                  onValueChange={(v) => setDeriveForm(prev => ({ ...prev, year: parseInt(v) }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((year) => (
                      <SelectItem key={year} value={String(year)}>{year}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeriveDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleDerive} disabled={deriving || !deriveForm.doctorId}>
              {deriving ? 'Deriving...' : 'Derive Payout'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default PayoutsList;

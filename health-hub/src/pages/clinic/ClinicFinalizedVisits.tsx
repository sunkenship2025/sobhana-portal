import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '@/lib/api';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CheckCircle2, Search, Eye, Printer, FileText, Phone, Stethoscope, Loader2 } from 'lucide-react';
import { formatPatientName, compactAge } from '@/lib/patientDisplay';
import { WorklistPager } from '@/components/worklist/WorklistPager';
import { useRevalidateOnFocus } from '@/hooks/useRevalidateOnFocus';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { DateRangeFilter } from '@/components/worklist/DateRangeFilter';
import {
  type DateRangeState,
  makeDateRange,
  dateRangeFrom,
} from '@/lib/dateFilter';

// Shape returned by GET /api/visits/clinic (mirrors ClinicVisitQueue's QueueVisit).
interface ClinicVisit {
  id: string;
  branchId: string;
  visitRef: string;
  billNumber?: string | null;
  hasBill?: boolean;
  patientId: string;
  patient: {
    id: string;
    name: string;
    gender: string;
    age: number;
    identifiers: Array<{ type: string; value: string }>;
  };
  domain: string;
  status: string;
  visitType: string;
  hospitalWard?: string | null;
  doctorId: string | null;
  doctor?: { id: string; name: string; qualification?: string; specialty?: string } | null;
  consultationFee: number;
  paymentType?: string | null;
  paymentStatus?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}


const ClinicFinalizedVisits = () => {
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [dateRange, setDateRangeState] = useState<DateRangeState>(makeDateRange('today'));
  const [visitTypeFilter, setVisitTypeFilterState] = useState('all');
  const [search, setSearchState] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [visits, setVisits] = useState<ClinicVisit[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedVisit, setSelectedVisit] = useState<ClinicVisit | null>(null);

  // A new date range, visit-type, or search term always restarts on page 1 —
  // otherwise a narrower filter could land on a now-nonexistent page.
  const setDateRange = (value: DateRangeState) => {
    setDateRangeState(value);
    setPage(1);
  };
  const setVisitTypeFilter = (value: string) => {
    setVisitTypeFilterState(value);
    setPage(1);
  };
  const setSearch = (value: string) => {
    setSearchState(value);
    setPage(1);
  };

  // Fetch one page of finalized OP/IP visits from the server. Search,
  // date-range bounding, visit-type filter, sort, and pagination all happen
  // server-side now (see clinicVisits.ts GET "/" status=COMPLETED handling)
  // — this used to fetch every COMPLETED clinic visit ever and do all of
  // that client-side. `silent` skips the full-page spinner so background
  // revalidation swaps data in place.
  const fetchVisits = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      if (!token || !activeBranchId) {
        if (!silent) setLoading(false);
        return;
      }
      try {
        if (!silent) setLoading(true);
        const params = new URLSearchParams({
          status: 'COMPLETED',
          page: String(page),
          pageSize: '20',
        });
        const from = dateRangeFrom(dateRange);
        if (from) params.set('from', from);
        if (visitTypeFilter !== 'all') params.set('visitType', visitTypeFilter);
        if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
        const res = await fetch(`${API_BASE}/visits/clinic?${params.toString()}`, {
          headers: { 'Authorization': `Bearer ${token}`, 'x-branch-id': activeBranchId },
        });
        if (res.ok) {
          const data = await res.json();
          setVisits(data.items ?? []);
          setTotal(data.total ?? 0);
          setTotalPages(data.totalPages ?? 1);
        }
      } catch (err) {
        console.error('Failed to fetch finalized clinic visits:', err);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token, activeBranchId, dateRange, visitTypeFilter, debouncedSearch, page],
  );

  useEffect(() => {
    void fetchVisits();
  }, [fetchVisits]);

  // Revalidate when the staff return to a stale tab so newly finalized OP/IP
  // visits show up without a manual refresh.
  useRevalidateOnFocus(() => void fetchVisits({ silent: true }), {
    enabled: Boolean(token && activeBranchId),
    pollMs: 60_000,
  });

  // Server already applied every filter, the search ranking, and pagination.
  const hasData = Boolean(search.trim()) || visitTypeFilter !== 'all' || dateRange.preset !== 'today';

  if (loading) {
    return (
      <AppLayout context="clinic" subContext="Reception">
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="clinic" subContext="Reception">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Finalized OP / IP</h1>
          <p className="text-muted-foreground">Completed clinic consultations</p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <DateRangeFilter
                value={dateRange}
                onChange={setDateRange}
                triggerClassName="w-full sm:w-[160px]"
              />
              <div className="space-y-2">
                <Label>Visit Type</Label>
                <Select value={visitTypeFilter} onValueChange={setVisitTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[140px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="OP">OP</SelectItem>
                    <SelectItem value="IP">IP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 w-full flex-1 sm:max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Name / Phone / Visit Ref / Bill Number"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Finalized list */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              Finalized ({total})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {total === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  {hasData ? <Search className="h-5 w-5" /> : <CheckCircle2 className="h-5 w-5" />}
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    {hasData ? 'No visits match your filters' : 'No finalized OP / IP yet'}
                  </p>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    {hasData
                      ? 'Try a different date range or clear the search.'
                      : 'Completed consultations appear here once a clinic visit is marked done.'}
                  </p>
                </div>
                {hasData && (
                  <Button variant="outline" size="sm" onClick={() => { setDateRange(makeDateRange('all')); setVisitTypeFilter('all'); setSearch(''); }}>
                    Clear filters
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {visits.map((visit) => {
                  const ageStr = compactAge(visit.patient);
                  const genderStr = visit.patient.gender || '';
                  const phone = visit.patient.identifiers.find((i) => i.type === 'PHONE')?.value || '';
                  return (
                    <div
                      key={visit.id}
                      className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{formatPatientName(visit.patient.name, (visit.patient as any).title)}</span>
                          {(ageStr || genderStr) && (
                            <span className="text-muted-foreground">
                              {ageStr}{ageStr && genderStr ? ' | ' : ''}{genderStr}
                            </span>
                          )}
                          <span className="text-xs px-2 py-0.5 rounded bg-muted font-medium">{visit.visitType}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          <span>Bill #: <span className="font-mono">{visit.billNumber || '—'}</span></span>
                          {phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone className="h-3.5 w-3.5 shrink-0" />{phone}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <Stethoscope className="h-3.5 w-3.5 shrink-0" />{visit.doctor?.name || '—'}
                          </span>
                          <span>Visit Ref: <span className="font-mono">{visit.visitRef}</span></span>
                        </div>
                        <StatusBadge status={visit.status} />
                      </div>
                      <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:items-center">
                        <Button
                          variant="outline"
                          size="icon"
                          className="w-full sm:w-10"
                          onClick={() => setSelectedVisit(visit)}
                          title="View"
                          aria-label="View visit"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="w-full sm:w-10"
                          onClick={() => window.open(`/prescription/print/${visit.id}`, '_blank')}
                          title="Print prescription"
                          aria-label="Print prescription"
                        >
                          <FileText className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          className="w-full sm:w-10"
                          onClick={() => navigate(`/bill/print/CLINIC/${visit.id}`)}
                          disabled={!visit.hasBill}
                          title={visit.hasBill ? 'Print bill' : 'Not billed'}
                          aria-label="Print bill"
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                <WorklistPager
                  page={page}
                  totalPages={totalPages}
                  hasPrev={page > 1}
                  hasNext={page < totalPages}
                  onPrev={() => setPage((p) => Math.max(1, p - 1))}
                  onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Visit details */}
      <Dialog open={!!selectedVisit} onOpenChange={() => setSelectedVisit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Visit Details</DialogTitle>
          </DialogHeader>
          {selectedVisit && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Patient</p>
                  <p className="font-medium">{formatPatientName(selectedVisit.patient.name, (selectedVisit.patient as any).title)}</p>
                  <p className="text-sm text-muted-foreground">
                    {(selectedVisit.patient as any).ageDisplay || selectedVisit.patient.age} | {selectedVisit.patient.gender === 'M' ? 'Male' : selectedVisit.patient.gender === 'F' ? 'Female' : 'Other'}
                  </p>
                  <p className="text-sm">{selectedVisit.patient.identifiers.find((i) => i.type === 'PHONE')?.value}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Visit Reference</p>
                  <p className="font-mono font-bold">{selectedVisit.visitRef}</p>
                  {selectedVisit.billNumber && (
                    <p className="text-sm text-muted-foreground mt-1">Bill #: <span className="font-mono text-foreground">{selectedVisit.billNumber}</span></p>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Visit Type</p>
                  <p className="font-medium">{selectedVisit.visitType}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Doctor</p>
                  <p className="font-medium">{selectedVisit.doctor?.name || '—'}</p>
                </div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <StatusBadge status={selectedVisit.status} />
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                <Button variant="outline" onClick={() => window.open(`/prescription/print/${selectedVisit.id}`, '_blank')}>
                  <FileText className="mr-2 h-4 w-4" /> Print prescription
                </Button>
                {selectedVisit.hasBill && (
                  <Button variant="outline" onClick={() => navigate(`/bill/print/CLINIC/${selectedVisit.id}`)}>
                    <Printer className="mr-2 h-4 w-4" /> Print bill
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default ClinicFinalizedVisits;

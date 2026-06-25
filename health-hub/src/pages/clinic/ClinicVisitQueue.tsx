import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Search, Users, RotateCcw, Loader2, Plus } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatPatientName } from '@/lib/patientDisplay';

// Shape returned by GET /api/visits/clinic
interface QueueVisit {
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
    dateOfBirth?: string;
    yearOfBirth: number;
    age: number;
    identifiers: Array<{ type: string; value: string }>;
  };
  domain: string;
  status: string;
  visitType: string;
  hospitalWard?: string | null;
  doctorId: string | null;
  doctor?: {
    id: string;
    name: string;
    qualification?: string;
    specialty?: string;
  } | null;
  totalAmount: number;
  consultationFee: number;
  isRevisit: boolean;
  originalVisitId?: string | null;
  originalVisitVisitRef?: string | null;
  originalVisitBillNumber?: string | null;
  originalVisitDate?: string | null;
  paymentType?: string | null;
  paymentStatus?: string | null;
  createdAt: string;
  updatedAt: string;
}

const ClinicVisitQueue = () => {
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [visits, setVisits] = useState<QueueVisit[]>([]);
  const [loading, setLoading] = useState(true);

  const [visitTypeFilter, setVisitTypeFilter] = useState('all');
  const [doctorFilter, setDoctorFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selectedVisit, setSelectedVisit] = useState<QueueVisit | null>(null);
  const [updatingVisitId, setUpdatingVisitId] = useState<string | null>(null);

  const fetchVisits = async () => {
    if (!activeBranchId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/visits/clinic`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-branch-id': activeBranchId,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setVisits(data);
      }
    } catch (err) {
      console.error('Failed to fetch clinic visits:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch visits from API
  useEffect(() => {
    fetchVisits();
  }, [activeBranchId, token]);

  // Get unique doctors for filter dropdown
  const doctorOptions = useMemo(() => {
    const doctorMap = new Map<string, string>();
    visits.forEach((v) => {
      if (v.doctor && v.doctorId) {
        doctorMap.set(v.doctorId, v.doctor.name);
      }
    });
    return [
      { id: 'all', name: 'All Doctors' },
      ...Array.from(doctorMap.entries()).map(([id, name]) => ({ id, name })),
    ];
  }, [visits]);

  // Filter visits
  const filteredVisits = useMemo(() => {
    const queueVisits = visits.filter((visit) =>
      visit.status === 'WAITING' || visit.status === 'IN_PROGRESS',
    );

    return queueVisits.filter((visit) => {
      // Visit type filter
      if (visitTypeFilter !== 'all' && visit.visitType !== visitTypeFilter) return false;

      // Doctor filter
      if (doctorFilter !== 'all' && visit.doctorId !== doctorFilter) return false;

      // Search filter
      if (search) {
        const searchLower = search.toLowerCase();
        const phone = visit.patient.identifiers.find((i) => i.type === 'PHONE')?.value || '';
        return (
          phone.includes(search) ||
          visit.visitRef.toLowerCase().includes(searchLower) ||
          (visit.billNumber || '').toLowerCase().includes(searchLower) ||
          visit.patient.name.toLowerCase().includes(searchLower)
        );
      }

      return true;
    }).sort((a, b) => {
      const statusOrder = { WAITING: 0, IN_PROGRESS: 1 } as Record<string, number>;
      const statusDelta = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
      if (statusDelta !== 0) {
        return statusDelta;
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [visits, visitTypeFilter, doctorFilter, search]);

  const updateVisitStatus = async (visit: QueueVisit, status: 'IN_PROGRESS' | 'COMPLETED') => {
    if (!activeBranchId) return;

    setUpdatingVisitId(visit.id);
    try {
      const res = await fetch(`${API_BASE}/visits/clinic/${visit.id}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId,
        },
        body: JSON.stringify({ status }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || 'Failed to update visit status');
      }

      setVisits((currentVisits) =>
        currentVisits.map((currentVisit) =>
          currentVisit.id === visit.id
            ? {
                ...currentVisit,
                status: data.status,
                updatedAt: new Date().toISOString(),
              }
            : currentVisit,
        ),
      );

      setSelectedVisit((currentVisit) =>
        currentVisit?.id === visit.id
          ? {
              ...currentVisit,
              status: data.status,
              updatedAt: new Date().toISOString(),
            }
          : currentVisit,
      );

      toast.success(
        status === 'IN_PROGRESS'
          ? 'Visit moved to ongoing'
          : 'Visit marked as done',
      );

      if (status === 'COMPLETED') {
        setSelectedVisit(null);
      }
    } catch (error: any) {
      console.error('Failed to update visit status:', error);
      toast.error(error.message || 'Failed to update visit status');
    } finally {
      setUpdatingVisitId(null);
    }
  };

  return (
    <AppLayout context="clinic" subContext="Reception">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Visit Queue</h1>
          <p className="text-muted-foreground">Who is waiting or active in the clinic today?</p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <div className="space-y-2">
                <Label>Visit Type</Label>
                <Select value={visitTypeFilter} onValueChange={setVisitTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="OP">OP</SelectItem>
                    <SelectItem value="IP">IP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Doctor</Label>
                <Select value={doctorFilter} onValueChange={setDoctorFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doctorOptions.map((doctor) => (
                      <SelectItem key={doctor.id} value={doctor.id}>{doctor.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 w-full flex-1 sm:max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Phone / Visit Ref / Bill Number / Name"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Visit Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" style={{ color: 'var(--branch-accent)' }} />
              Visit Queue ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : filteredVisits.length === 0 ? (
              (() => {
                const hasFilters =
                  visitTypeFilter !== 'all' ||
                  doctorFilter !== 'all' ||
                  search.trim() !== '';
                return (
                  <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      {hasFilters ? (
                        <Search className="h-5 w-5" />
                      ) : (
                        <Users className="h-5 w-5" />
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {hasFilters
                          ? 'No visits match your filters'
                          : 'The queue is clear'}
                      </p>
                      <p className="max-w-sm text-sm text-muted-foreground">
                        {hasFilters
                          ? 'Try a different doctor, visit type, or search term.'
                          : 'No one is waiting or active right now. New visits appear here as they are registered.'}
                      </p>
                    </div>
                    {hasFilters ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setVisitTypeFilter('all');
                          setDoctorFilter('all');
                          setSearch('');
                        }}
                      >
                        Clear filters
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => navigate('/clinic/new')}>
                        <Plus className="mr-2 h-4 w-4" />
                        New clinic visit
                      </Button>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="space-y-3">
                {filteredVisits.map((visit) => {
                  const phone = visit.patient.identifiers.find((i) => i.type === 'PHONE')?.value || '';
                  const isUpdatingThisVisit = updatingVisitId === visit.id;
                  const revisitLabel = visit.visitType === 'OP' ? 'Revisit OP' : 'Recurring Visit';
                  return (
                    <div
                      key={visit.id}
                      className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 lg:flex-row lg:items-center lg:justify-between"
                    >
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{formatPatientName(visit.patient.name, (visit.patient as any).title)}</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-muted font-medium">
                            {visit.visitType}
                          </span>
                          {visit.isRevisit && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                              <RotateCcw className="h-3 w-3" />
                              {revisitLabel}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                          <span className="text-muted-foreground">
                            Doctor: <span className="text-foreground">{visit.doctor?.name || '—'}</span>
                          </span>
                          <span className="text-muted-foreground">
                            Visit Ref: <span className="font-mono">{visit.visitRef}</span>
                          </span>
                          {visit.billNumber && (
                            <span className="text-muted-foreground">
                              Bill #: <span className="font-mono">{visit.billNumber}</span>
                            </span>
                          )}
                          {phone && (
                            <span className="text-muted-foreground">
                              Ph: <span className="text-foreground">{phone}</span>
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-sm">₹{visit.totalAmount.toLocaleString('en-IN')}</span>
                          {visit.hasBill ? (
                            <>
                              <span className="text-sm text-muted-foreground">{visit.paymentType}</span>
                              {visit.paymentStatus ? <StatusBadge status={visit.paymentStatus} /> : null}
                            </>
                          ) : (
                            <span className="text-sm text-muted-foreground">Not billed</span>
                          )}
                          <StatusBadge status={visit.status} />
                        </div>

                        {visit.isRevisit && (visit.originalVisitBillNumber || visit.originalVisitDate) && (
                          <div className="text-xs text-blue-700">
                            Original visit:
                            {visit.originalVisitVisitRef ? ` Ref ${visit.originalVisitVisitRef}` : ''}
                            {visit.originalVisitBillNumber ? ` Bill #${visit.originalVisitBillNumber}` : ''}
                            {visit.originalVisitDate
                              ? ` on ${new Date(visit.originalVisitDate).toLocaleDateString('en-IN')}`
                              : ''}
                          </div>
                        )}
                      </div>

                      <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end lg:min-w-[320px]">
                        {visit.status === 'WAITING' && (
                          <Button
                            size="sm"
                            className="w-full sm:w-auto"
                            onClick={() => updateVisitStatus(visit, 'IN_PROGRESS')}
                            disabled={isUpdatingThisVisit}
                          >
                            {isUpdatingThisVisit ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            Move To Ongoing
                          </Button>
                        )}

                        {visit.status !== 'COMPLETED' && (
                          <Button
                            size="sm"
                            className="w-full sm:w-auto"
                            variant={visit.status === 'IN_PROGRESS' ? 'default' : 'outline'}
                            onClick={() => updateVisitStatus(visit, 'COMPLETED')}
                            disabled={isUpdatingThisVisit}
                          >
                            {isUpdatingThisVisit ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            Mark Done
                          </Button>
                        )}

                        <Button className="w-full sm:w-auto" variant="outline" size="sm" onClick={() => setSelectedVisit(visit)}>
                          View
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Visit Details Dialog */}
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
                    <p className="text-sm text-muted-foreground mt-1">
                      Bill #: <span className="font-mono text-foreground">{selectedVisit.billNumber}</span>
                    </p>
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

              {selectedVisit.hospitalWard && (
                <div>
                  <p className="text-sm text-muted-foreground">Hospital/Ward</p>
                  <p className="font-medium">{selectedVisit.hospitalWard}</p>
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-sm text-muted-foreground">Consultation Fee</p>
                  <p className="font-bold">₹{selectedVisit.consultationFee.toLocaleString('en-IN')}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Payment</p>
                  {selectedVisit.hasBill ? (
                    <div className="flex items-center gap-2">
                      <span>{selectedVisit.paymentType}</span>
                      {selectedVisit.paymentStatus ? <StatusBadge status={selectedVisit.paymentStatus} /> : null}
                    </div>
                  ) : (
                    <p className="font-medium text-muted-foreground">Not billed</p>
                  )}
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <StatusBadge status={selectedVisit.status} />
              </div>

              {selectedVisit.isRevisit && (
                <div className="bg-blue-50 dark:bg-blue-950/30 p-3 rounded-lg">
                  <p className="text-sm text-blue-700 dark:text-blue-300 font-medium flex items-center gap-1">
                    <RotateCcw className="h-3 w-3" /> This is a recurring / revisit consultation with free follow-up
                  </p>
                  {(selectedVisit.originalVisitBillNumber || selectedVisit.originalVisitDate) && (
                    <p className="mt-1 text-xs text-blue-700/80 dark:text-blue-300/80">
                      Original visit:
                      {selectedVisit.originalVisitVisitRef ? ` Ref ${selectedVisit.originalVisitVisitRef}` : ''}
                      {selectedVisit.originalVisitBillNumber ? ` Bill #${selectedVisit.originalVisitBillNumber}` : ''}
                      {selectedVisit.originalVisitDate
                        ? ` on ${new Date(selectedVisit.originalVisitDate).toLocaleDateString('en-IN')}`
                        : ''}
                    </p>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-2">
                {selectedVisit.status === 'WAITING' && (
                  <Button
                    onClick={() => updateVisitStatus(selectedVisit, 'IN_PROGRESS')}
                    disabled={updatingVisitId === selectedVisit.id}
                  >
                    {updatingVisitId === selectedVisit.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Move To Ongoing
                  </Button>
                )}

                {selectedVisit.status !== 'COMPLETED' && (
                  <Button
                    variant={selectedVisit.status === 'IN_PROGRESS' ? 'default' : 'outline'}
                    onClick={() => updateVisitStatus(selectedVisit, 'COMPLETED')}
                    disabled={updatingVisitId === selectedVisit.id}
                  >
                    {updatingVisitId === selectedVisit.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Mark Done
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

export default ClinicVisitQueue;

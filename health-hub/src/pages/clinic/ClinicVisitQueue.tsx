import { useState, useMemo, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Search, Users, RotateCcw, Loader2 } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// Shape returned by GET /api/visits/clinic
interface QueueVisit {
  id: string;
  branchId: string;
  billNumber: string;
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
  originalVisitBillNumber?: string | null;
  originalVisitDate?: string | null;
  paymentType: string;
  paymentStatus: string;
  createdAt: string;
  updatedAt: string;
}

const ClinicVisitQueue = () => {
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
          visit.billNumber.toLowerCase().includes(searchLower) ||
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
            <div className="flex flex-wrap gap-4">
              <div className="space-y-2">
                <Label>Visit Type</Label>
                <Select value={visitTypeFilter} onValueChange={setVisitTypeFilter}>
                  <SelectTrigger className="w-[140px]">
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
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {doctorOptions.map((doctor) => (
                      <SelectItem key={doctor.id} value={doctor.id}>{doctor.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 flex-1 max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Phone / Bill Number / Name"
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
              <div className="text-center py-8 text-muted-foreground">
                No visits found.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredVisits.map((visit) => {
                  const phone = visit.patient.identifiers.find((i) => i.type === 'PHONE')?.value || '';
                  return (
                    <div
                      key={visit.id}
                      className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{visit.patient.name}</span>
                          <span className="text-xs px-2 py-0.5 rounded bg-muted font-medium">
                            {visit.visitType}
                          </span>
                          {visit.isRevisit && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                              <RotateCcw className="h-3 w-3" />
                              Recurring Visit
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <span className="text-muted-foreground">
                            Doctor: <span className="text-foreground">{visit.doctor?.name || '—'}</span>
                          </span>
                          <span className="text-muted-foreground">
                            Bill #: <span className="font-mono">{visit.billNumber}</span>
                          </span>
                          {phone && (
                            <span className="text-muted-foreground">
                              Ph: <span className="text-foreground">{phone}</span>
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm">₹{visit.totalAmount.toLocaleString('en-IN')}</span>
                          <span className="text-sm text-muted-foreground">{visit.paymentType}</span>
                          <StatusBadge status={visit.paymentStatus} />
                          <StatusBadge status={visit.status} />
                        </div>
                      </div>
                      <Button variant="outline" onClick={() => setSelectedVisit(visit)}>
                        View
                      </Button>
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
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Patient</p>
                  <p className="font-medium">{selectedVisit.patient.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(selectedVisit.patient as any).ageDisplay || selectedVisit.patient.age} | {selectedVisit.patient.gender === 'M' ? 'Male' : selectedVisit.patient.gender === 'F' ? 'Female' : 'Other'}
                  </p>
                  <p className="text-sm">{selectedVisit.patient.identifiers.find((i) => i.type === 'PHONE')?.value}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Bill Number</p>
                  <p className="font-mono font-bold">{selectedVisit.billNumber}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Consultation Fee</p>
                  <p className="font-bold">₹{selectedVisit.consultationFee.toLocaleString('en-IN')}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Payment</p>
                  <div className="flex items-center gap-2">
                    <span>{selectedVisit.paymentType}</span>
                    <StatusBadge status={selectedVisit.paymentStatus} />
                  </div>
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

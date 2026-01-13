import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAppStore } from '@/store/appStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Search, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ClinicVisitView } from '@/types';

const ClinicVisitQueue = () => {
  const { clinicVisits, clinicDoctors, getPatientById, getClinicDoctorById } = useAppStore();
  const { activeBranchId } = useBranchStore();
  const [visitTypeFilter, setVisitTypeFilter] = useState('all');
  const [doctorFilter, setDoctorFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');
  const [selectedVisitView, setSelectedVisitView] = useState<ClinicVisitView | null>(null);

  const doctorOptions = useMemo(() => [{ id: 'all', name: 'All Doctors' }, ...clinicDoctors], [clinicDoctors]);

  // Filter by active branch and build view data
  const visitsWithDetails = useMemo(() => {
    return clinicVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: getPatientById(visit.patientId),
      }))
      .filter((v) => v.patient !== undefined) as { visit: typeof clinicVisits[0]; patient: NonNullable<ReturnType<typeof getPatientById>> }[];
  }, [clinicVisits, activeBranchId, getPatientById]);

  const filteredVisits = visitsWithDetails.filter(({ visit, patient }) => {
    // Visit type filter
    if (visitTypeFilter !== 'all' && visit.visitType !== visitTypeFilter) return false;
    
    // Doctor filter
    if (doctorFilter !== 'all' && visit.doctorId !== doctorFilter) return false;
    
    // Search filter
    if (search) {
      const searchLower = search.toLowerCase();
      const phone = patient.identifiers.find(i => i.type === 'PHONE')?.value || '';
      return (
        phone.includes(search) ||
        visit.billNumber.toLowerCase().includes(searchLower) ||
        patient.name.toLowerCase().includes(searchLower)
      );
    }
    
    return true;
  });

  const handleViewVisit = (visit: typeof clinicVisits[0], patient: NonNullable<ReturnType<typeof getPatientById>>) => {
    setSelectedVisitView({ visit, patient, clinicDoctor: getClinicDoctorById(visit.doctorId) });
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
              <div className="space-y-2">
                <Label>Date</Label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">This Week</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 flex-1 max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Phone / Bill Number"
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
              <Users className="h-5 w-5 text-context-clinic" />
              Visit Queue ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No visits found.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredVisits.map(({ visit, patient }) => (
                  <div
                    key={visit.id}
                    className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{patient.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded bg-muted font-medium">
                          {visit.visitType}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-muted-foreground">
                          Doctor: <span className="text-foreground">{getClinicDoctorById(visit.doctorId)?.name || visit.doctorId}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Bill #: <span className="font-mono">{visit.billNumber}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground">
                          Payment: {visit.paymentType}
                        </span>
                        <StatusBadge status={visit.paymentStatus} />
                        <StatusBadge status={visit.status} />
                      </div>
                    </div>
                    <Button variant="outline" onClick={() => handleViewVisit(visit, patient)}>
                      View
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Visit Details Dialog */}
      <Dialog open={!!selectedVisitView} onOpenChange={() => setSelectedVisitView(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Visit Details</DialogTitle>
          </DialogHeader>
          {selectedVisitView && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Patient</p>
                  <p className="font-medium">{selectedVisitView.patient.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {selectedVisitView.patient.age} | {selectedVisitView.patient.gender}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Bill Number</p>
                  <p className="font-mono font-bold">{selectedVisitView.visit.billNumber}</p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Visit Type</p>
                  <p className="font-medium">{selectedVisitView.visit.visitType}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Doctor</p>
                  <p className="font-medium">{selectedVisitView.clinicDoctor?.name || selectedVisitView.visit.doctorId}</p>
                </div>
              </div>

              {selectedVisitView.visit.hospitalWard && (
                <div>
                  <p className="text-sm text-muted-foreground">Hospital/Ward</p>
                  <p className="font-medium">{selectedVisitView.visit.hospitalWard}</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Consultation Fee</p>
                  <p className="font-bold">₹{(selectedVisitView.visit.consultationFeeInPaise / 100).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Payment</p>
                  <div className="flex items-center gap-2">
                    <span>{selectedVisitView.visit.paymentType}</span>
                    <StatusBadge status={selectedVisitView.visit.paymentStatus} />
                  </div>
                </div>
              </div>

              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <StatusBadge status={selectedVisitView.visit.status} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default ClinicVisitQueue;

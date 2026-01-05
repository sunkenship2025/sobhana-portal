import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAppStore } from '@/store/appStore';
import { useBranchStore } from '@/store/branchStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Clock, Search } from 'lucide-react';

const DiagnosticsPendingResults = () => {
  const navigate = useNavigate();
  const { getPendingDiagnosticVisits, getPatientById, getTestOrdersByVisitId } = useAppStore();
  const { activeBranchId } = useBranchStore();
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');

  const pendingVisits = getPendingDiagnosticVisits();

  // Filter by active branch and build view data
  const visitsWithDetails = useMemo(() => {
    return pendingVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: getPatientById(visit.patientId),
        testOrders: getTestOrdersByVisitId(visit.id),
      }));
  }, [pendingVisits, activeBranchId, getPatientById, getTestOrdersByVisitId]);

  const filteredVisits = visitsWithDetails.filter(({ patient, visit }) => {
    if (!search || !patient) return true;
    return (
      patient.phone.includes(search) ||
      patient.name.toLowerCase().includes(search.toLowerCase()) ||
      visit.billNumber.toLowerCase().includes(search.toLowerCase())
    );
  });

  return (
    <AppLayout context="diagnostics">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Pending Results</h1>
          <p className="text-muted-foreground">Which lab cases still need results entered?</p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-4">
              <div className="space-y-2">
                <Label>Date</Label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger className="w-[180px]">
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

        {/* Result Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-warning" />
              Result Queue ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No pending results found.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredVisits.map(({ visit, patient, testOrders }) => (
                  <div
                    key={visit.id}
                    className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{patient?.name || 'Unknown'}</span>
                        <span className="text-muted-foreground">
                          | {patient?.age} | {patient?.gender}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-muted-foreground">
                          Bill #: <span className="font-mono">{visit.billNumber}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Tests: {testOrders.map((t) => t.testCode).join(', ')}
                        </span>
                      </div>
                      <StatusBadge status={visit.status} />
                    </div>
                    <Button onClick={() => navigate(`/diagnostics/results/${visit.id}`)}>
                      Enter Results
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
};

export default DiagnosticsPendingResults;

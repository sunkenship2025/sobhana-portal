import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useBranchStore } from '@/store/branchStore';
import { useAuthStore } from '@/store/authStore';
import { StatusBadge } from '@/components/ui/status-badge';
import { Clock, Search, Loader2 } from 'lucide-react';

const DiagnosticsPendingResults = () => {
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');
  const [pendingVisits, setPendingVisits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch pending visits from API (DRAFT and WAITING status)
  useEffect(() => {
    const fetchPendingVisits = async () => {
      try {
        setLoading(true);
        // Fetch DRAFT visits (no results entered yet) and WAITING visits (results saved but not finalized)
        const [draftRes, waitingRes] = await Promise.all([
          fetch('http://localhost:3000/api/visits/diagnostic?status=DRAFT', {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId
            }
          }),
          fetch('http://localhost:3000/api/visits/diagnostic?status=WAITING', {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId
            }
          })
        ]);

        const draftData = draftRes.ok ? await draftRes.json() : [];
        const waitingData = waitingRes.ok ? await waitingRes.json() : [];
        
        // Combine and sort by createdAt
        const combined = [...draftData, ...waitingData].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setPendingVisits(combined);
      } catch (error) {
        console.error('Failed to fetch pending visits:', error);
      } finally {
        setLoading(false);
      }
    };

    if (token && activeBranchId) {
      fetchPendingVisits();
    }
  }, [token, activeBranchId]);

  // Build view data from API response
  const visitsWithDetails = useMemo(() => {
    return pendingVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: visit.patient, // API response includes patient data
        testOrders: visit.testOrders || [], // API response includes test orders
      }));
  }, [pendingVisits, activeBranchId]);

  const filteredVisits = visitsWithDetails.filter(({ patient, visit }) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    const phone = patient?.identifiers?.find((id: any) => id.type === 'PHONE')?.value || '';
    return (
      phone.includes(search) ||
      patient?.name.toLowerCase().includes(searchLower) ||
      visit.billNumber.toLowerCase().includes(searchLower)
    );
  });

  if (loading) {
    return (
      <AppLayout context="diagnostics">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

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

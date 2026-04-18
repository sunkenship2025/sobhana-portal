import { useState, useMemo, useEffect } from 'react';
import { API_BASE } from '@/lib/api';
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

const matchesDateFilter = (filter: string, value: string) => {
  if (filter === 'all') return true;

  const visitDate = new Date(value);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  if (filter === 'today') {
    return visitDate >= todayStart && visitDate < tomorrowStart;
  }

  if (filter === 'yesterday') {
    return visitDate >= yesterdayStart && visitDate < todayStart;
  }

  if (filter === 'week') {
    return visitDate >= weekStart && visitDate < tomorrowStart;
  }

  return true;
};

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
          fetch(`${API_BASE}/visits/diagnostic?status=DRAFT`, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'X-Branch-Id': activeBranchId
            }
          }),
          fetch(`${API_BASE}/visits/diagnostic?status=WAITING`, {
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

  const filteredVisits = useMemo(() => {
    return visitsWithDetails.filter(({ patient, visit }) => {
      if (!visit.hasReportableOrders || visit.nextAction !== 'ENTER_RESULTS') {
        return false;
      }

      if (!matchesDateFilter(dateFilter, visit.createdAt)) {
        return false;
      }

      if (!search) return true;
      const searchLower = search.toLowerCase();
      const phone = patient?.identifiers?.find((id: any) => id.type === 'PHONE')?.value || '';
      return (
        phone.includes(search) ||
        patient?.name.toLowerCase().includes(searchLower) ||
        visit.billNumber.toLowerCase().includes(searchLower)
      );
    });
  }, [visitsWithDetails, dateFilter, search]);

  const handleAction = (visit: any) => {
    navigate(`/diagnostics/results/${visit.id}`);
  };

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
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <div className="space-y-2">
                <Label>Date</Label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">This Week</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 w-full flex-1 sm:max-w-sm">
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
                    className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{patient?.name || 'Unknown'}</span>
                        <span className="text-muted-foreground">
                          | {patient?.age} | {patient?.gender}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span className="text-muted-foreground">
                          Bill #: <span className="font-mono">{visit.billNumber}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Tests: {testOrders
                            .filter((testOrder) => testOrder.workflowMode !== 'BILL_ONLY')
                            .map((testOrder) => testOrder.testCode)
                            .join(', ')}
                        </span>
                        {visit.hasBillOnlyOrders && visit.hasReportableOrders && (
                          <span className="text-amber-700">Includes bill-only items</span>
                        )}
                      </div>
                      <StatusBadge status={visit.status} />
                    </div>
                    <Button className="w-full sm:w-auto" onClick={() => handleAction(visit)}>
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

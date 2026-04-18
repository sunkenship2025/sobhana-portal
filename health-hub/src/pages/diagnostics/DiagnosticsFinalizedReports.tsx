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
import { toast } from 'sonner';
import { CheckCircle2, Search, Eye, Printer, MessageCircle, Loader2 } from 'lucide-react';
import { openFinalizedReportWindow } from '@/lib/reportAccess';

const matchesDateFilter = (filter: string, value: string | null | undefined) => {
  if (filter === 'all') return true;

  const source = value ? new Date(value) : null;
  if (!source) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  if (filter === 'today') {
    return source >= todayStart && source < tomorrowStart;
  }

  if (filter === 'yesterday') {
    return source >= yesterdayStart && source < todayStart;
  }

  if (filter === 'week') {
    return source >= weekStart && source < tomorrowStart;
  }

  return true;
};

const DiagnosticsFinalizedReports = () => {
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');
  const [finalizedVisits, setFinalizedVisits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Fetch finalized visits from API
  useEffect(() => {
    const fetchFinalizedVisits = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${API_BASE}/visits/diagnostic?status=COMPLETED`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Branch-Id': activeBranchId
          }
        });
        
        if (response.ok) {
          const data = await response.json();
          setFinalizedVisits(data);
        }
      } catch (error) {
        console.error('Failed to fetch finalized visits:', error);
      } finally {
        setLoading(false);
      }
    };

    if (token && activeBranchId) {
      fetchFinalizedVisits();
    }
  }, [token, activeBranchId]);

  // Build view data from API response
  const visitsWithDetails = useMemo(() => {
    return finalizedVisits
      .filter((visit) => visit.hasFinalizedReport)
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: visit.patient, // API response includes patient data
        testOrders: visit.testOrders || [], // API response includes test orders
      }));
  }, [finalizedVisits, activeBranchId]);

  const filteredVisits = useMemo(() => {
    return visitsWithDetails.filter(({ patient, visit }) => {
      const finalizedAt =
        visit.report?.currentVersion?.finalizedAt ||
        visit.report?.versions?.[0]?.finalizedAt ||
        visit.updatedAt ||
        visit.createdAt;

      if (!matchesDateFilter(dateFilter, finalizedAt)) {
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

  const handleWhatsApp = async (visitId: string) => {
    try {
      const response = await fetch(`${API_BASE}/messages/${visitId}/send-report`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Branch-Id': activeBranchId,
        },
      });
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success('Completion notification sent via WhatsApp');
      } else {
        toast.error(data.error || 'Failed to send WhatsApp notification');
      }
    } catch (error) {
      toast.error('Failed to send WhatsApp notification');
    }
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
          <h1 className="text-2xl font-bold">Finalized Reports</h1>
          <p className="text-muted-foreground">View and share completed lab reports</p>
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
                    placeholder="Phone / Name / Bill Number"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Finalized Reports List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
              Finalized Reports ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No finalized reports found.
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
                      </div>
                      <StatusBadge status={visit.status} />
                    </div>
                    <div className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:items-center">
                      <Button 
                        variant="outline" 
                        size="icon"
                        className="w-full sm:w-10"
                        onClick={() => navigate(`/diagnostics/preview/${visit.id}`)}
                        title="View Report"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        className="w-full sm:w-10"
                        onClick={() => {
                          openFinalizedReportWindow({
                            visitId: visit.id,
                            token,
                            branchId: activeBranchId,
                            autoPrint: true,
                          }).catch((error) => {
                            console.error('Print failed:', error);
                            toast.error('Report not available');
                          });
                        }}
                        title="Print"
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="icon"
                        className="w-full sm:w-10"
                        onClick={() => handleWhatsApp(visit.id)}
                        title="Send via WhatsApp"
                      >
                        <MessageCircle className="h-4 w-4" />
                      </Button>
                    </div>
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

export default DiagnosticsFinalizedReports;

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
import { CheckCircle2, Search, Eye, Printer, MessageCircle } from 'lucide-react';

const DiagnosticsFinalizedReports = () => {
  const navigate = useNavigate();
  const { getFinalizedDiagnosticVisits, getPatientById, getTestOrdersByVisitId } = useAppStore();
  const { activeBranchId } = useBranchStore();
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');

  const finalizedVisits = getFinalizedDiagnosticVisits();

  // Filter by active branch and build view data
  const visitsWithDetails = useMemo(() => {
    return finalizedVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: getPatientById(visit.patientId),
        testOrders: getTestOrdersByVisitId(visit.id),
      }));
  }, [finalizedVisits, activeBranchId, getPatientById, getTestOrdersByVisitId]);

  const filteredVisits = visitsWithDetails.filter(({ patient, visit }) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      patient?.phone.includes(search) ||
      patient?.name.toLowerCase().includes(searchLower) ||
      visit.billNumber.toLowerCase().includes(searchLower)
    );
  });

  const handleWhatsApp = (phone: string, name: string, billNumber: string) => {
    const message = `Lab Report Ready\n\nPatient: ${name}\nBill #: ${billNumber}\n\nPlease visit the clinic to collect your report.`;
    const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
    window.open(url, '_blank');
  };

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
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 flex-1 max-w-sm">
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
                    <div className="flex items-center gap-2">
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={() => navigate(`/diagnostics/preview/${visit.id}`)}
                        title="View Report"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={() => window.print()}
                        title="Print"
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="outline" 
                        size="icon"
                        onClick={() => patient && handleWhatsApp(patient.phone, patient.name, visit.billNumber)}
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

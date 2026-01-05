import { useState, useMemo } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAppStore } from '@/store/appStore';
import { FlagBadge } from '@/components/ui/flag-badge';
import { Search, FileText, Eye } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { DiagnosticVisitView } from '@/types';

const DoctorDashboard = () => {
  const { 
    diagnosticVisits, 
    getPatientById, 
    getTestOrdersByVisitId,
    getDiagnosticVisitView,
  } = useAppStore();
  const [dateFilter, setDateFilter] = useState('today');
  const [search, setSearch] = useState('');
  const [selectedVisitView, setSelectedVisitView] = useState<DiagnosticVisitView | null>(null);

  // Get visits with DRAFT or FINALIZED status (have results)
  const reportsWithResults = diagnosticVisits.filter(
    (v) => v.status === 'FINALIZED' || v.status === 'DRAFT'
  );

  // Build view data for each visit
  const visitsWithDetails = useMemo(() => {
    return reportsWithResults.map((visit) => {
      const visitView = getDiagnosticVisitView(visit.id);
      return visitView;
    }).filter((v): v is DiagnosticVisitView => v !== undefined);
  }, [reportsWithResults, getDiagnosticVisitView]);

  const filteredReports = visitsWithDetails.filter((visitView) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      visitView.patient.phone.includes(search) ||
      visitView.visit.billNumber.toLowerCase().includes(searchLower) ||
      visitView.patient.name.toLowerCase().includes(searchLower)
    );
  });

  return (
    <AppLayout context="doctor">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">My Reports</h1>
          <p className="text-muted-foreground">Which finalized reports are available for me?</p>
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
                    placeholder="Patient / Bill Number"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Report List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-context-doctor" />
              Report List ({filteredReports.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredReports.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No reports found.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredReports.map((visitView) => {
                  const hasAbnormal = visitView.results.some(
                    (r) => r.flag === 'HIGH' || r.flag === 'LOW'
                  );
                  
                  return (
                    <div
                      key={visitView.visit.id}
                      className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{visitView.patient.name}</span>
                          <span className="text-muted-foreground">
                            | {visitView.patient.age} | {visitView.patient.gender}
                          </span>
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                          <span className="text-muted-foreground">
                            Bill #: <span className="font-mono">{visitView.visit.billNumber}</span>
                          </span>
                          <span className="text-muted-foreground">
                            Tests: {visitView.testOrders.map((t) => t.testCode).join(', ')}
                          </span>
                        </div>
                        {hasAbnormal && (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-muted-foreground">Flags:</span>
                            {visitView.results
                              .filter((r) => r.flag === 'HIGH' || r.flag === 'LOW')
                              .map((r) => (
                                <FlagBadge key={r.id} flag={r.flag} />
                              ))}
                          </div>
                        )}
                      </div>
                      <Button 
                        variant="outline" 
                        onClick={() => setSelectedVisitView(visitView)}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        View Report
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Report View Dialog */}
      <Dialog open={!!selectedVisitView} onOpenChange={() => setSelectedVisitView(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Report (Read Only)</DialogTitle>
          </DialogHeader>
          {selectedVisitView && (
            <div className="space-y-4">
              <div className="flex justify-between p-4 bg-muted rounded-lg">
                <div>
                  <p className="font-semibold text-lg">{selectedVisitView.patient.name}</p>
                  <p className="text-muted-foreground">
                    {selectedVisitView.patient.age} years | {selectedVisitView.patient.gender === 'M' ? 'Male' : selectedVisitView.patient.gender === 'F' ? 'Female' : 'Other'}
                  </p>
                </div>
                <div className="text-right">
                  <p className="font-mono font-bold">{selectedVisitView.visit.billNumber}</p>
                  <p className="text-sm text-muted-foreground">
                    {new Date(selectedVisitView.visit.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Test</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                    <TableHead className="text-right">Range</TableHead>
                    <TableHead className="text-right">Flag</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selectedVisitView.results.map((result) => (
                    <TableRow key={result.id}>
                      <TableCell className="font-medium">{result.testName}</TableCell>
                      <TableCell className="text-right font-mono">
                        {result.value ?? '—'}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {result.referenceRange.min > 0 || result.referenceRange.max > 0
                          ? `${result.referenceRange.min}–${result.referenceRange.max} ${result.referenceRange.unit}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <FlagBadge flag={result.flag} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default DoctorDashboard;

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';
import {
  FlaskConical,
  Stethoscope,
  Users,
  Clock,
  CheckCircle2,
  ArrowRight,
  AlertCircle,
  Loader2,
} from 'lucide-react';

type DiagnosticVisitSummary = {
  id: string;
  branchId: string;
  status: string;
  hasReportableOrders?: boolean;
  hasFinalizedReport?: boolean;
  createdAt: string;
};

type ClinicVisitSummary = {
  id: string;
  branchId: string;
  visitType: string;
  status: string;
  createdAt: string;
};

function isSameLocalDay(value: string, reference: Date): boolean {
  const date = new Date(value);
  return (
    date.getFullYear() === reference.getFullYear() &&
    date.getMonth() === reference.getMonth() &&
    date.getDate() === reference.getDate()
  );
}

const Dashboard = () => {
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [diagnosticVisits, setDiagnosticVisits] = useState<DiagnosticVisitSummary[]>([]);
  const [clinicVisits, setClinicVisits] = useState<ClinicVisitSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDashboardData = async () => {
      if (!token || !activeBranchId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const [diagnosticRes, clinicRes] = await Promise.all([
          fetch(`${API_BASE}/visits/diagnostic`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Branch-Id': activeBranchId,
            },
          }),
          fetch(`${API_BASE}/visits/clinic`, {
            headers: {
              Authorization: `Bearer ${token}`,
              'X-Branch-Id': activeBranchId,
            },
          }),
        ]);

        if (!diagnosticRes.ok || !clinicRes.ok) {
          throw new Error('Failed to fetch dashboard data');
        }

        const [diagnosticData, clinicData] = await Promise.all([
          diagnosticRes.json(),
          clinicRes.json(),
        ]);

        setDiagnosticVisits(diagnosticData || []);
        setClinicVisits(clinicData || []);
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, [token, activeBranchId]);

  const metrics = useMemo(() => {
    const today = new Date();
    const pendingResults = diagnosticVisits.filter(
      (visit) => visit.hasReportableOrders && (visit.status === 'DRAFT' || visit.status === 'WAITING'),
    );
    const finalizedReports = diagnosticVisits.filter((visit) => visit.hasFinalizedReport);
    const waitingOP = clinicVisits.filter(
      (visit) => visit.visitType === 'OP' && visit.status === 'WAITING',
    );
    const activeIP = clinicVisits.filter(
      (visit) => visit.visitType === 'IP' && visit.status === 'IN_PROGRESS',
    );
    const todayOP = clinicVisits.filter(
      (visit) => visit.visitType === 'OP' && isSameLocalDay(visit.createdAt, today),
    );
    const todayIP = clinicVisits.filter(
      (visit) => visit.visitType === 'IP' && isSameLocalDay(visit.createdAt, today),
    );
    const diagnosticsToday = diagnosticVisits.filter((visit) => isSameLocalDay(visit.createdAt, today));
    const finalizedToday = finalizedReports.filter((visit) => isSameLocalDay(visit.createdAt, today));

    return {
      pendingResults,
      waitingOP,
      activeIP,
      todayOP,
      todayIP,
      diagnosticsToday,
      finalizedToday,
      hasPendingWork: pendingResults.length > 0 || waitingOP.length > 0 || activeIP.length > 0,
    };
  }, [diagnosticVisits, clinicVisits]);

  return (
    <AppLayout context="dashboard">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground">Today's work at a glance</p>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading live branch data...
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-3">
          <Card className={metrics.pendingResults.length > 0 ? 'border-warning/50 bg-warning/5' : ''}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {metrics.pendingResults.length > 0 && <AlertCircle className="h-4 w-4 text-warning" />}
                Pending Lab Results
              </CardTitle>
              <FlaskConical className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${metrics.pendingResults.length > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                {metrics.pendingResults.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">awaiting result entry</p>
              <Button asChild size="sm" variant={metrics.pendingResults.length > 0 ? 'default' : 'outline'}>
                <Link to="/diagnostics/pending">
                  Enter Results <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {metrics.waitingOP.length > 0 && <Clock className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />}
                Waiting OP Patients
              </CardTitle>
              <Stethoscope className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-muted-foreground">
                {metrics.waitingOP.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">in queue</p>
              <Button asChild size="sm" variant="outline">
                <Link to="/clinic/queue">
                  View Queue <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {metrics.activeIP.length > 0 && <Clock className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />}
                Active IP Admissions
              </CardTitle>
              <Users className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-muted-foreground">
                {metrics.activeIP.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">currently admitted</p>
              <Button asChild size="sm" variant="outline">
                <Link to="/clinic/queue">
                  View Admissions <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2 btn-branch-outline">
                <Link to="/diagnostics/new">
                  <FlaskConical className="h-6 w-6" />
                  New Diagnostic Visit
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2 btn-branch-outline">
                <Link to="/clinic/new">
                  <Stethoscope className="h-6 w-6" />
                  New Clinic Visit
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2 btn-branch-outline">
                <Link to="/diagnostics/pending">
                  <Clock className="h-6 w-6" />
                  Enter Results
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2 btn-branch-outline">
                <Link to="/clinic/queue">
                  <Users className="h-6 w-6" />
                  Visit Queue
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Today's OP Visits
              </CardTitle>
              <Stethoscope className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.todayOP.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Today's IP Visits
              </CardTitle>
              <Users className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.todayIP.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Diagnostics Today
              </CardTitle>
              <FlaskConical className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{metrics.diagnosticsToday.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Reports Finalized
              </CardTitle>
              <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold" style={{ color: 'var(--branch-accent)' }}>
                {metrics.finalizedToday.length}
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {metrics.hasPendingWork ? (
                <>
                  <AlertCircle className="h-5 w-5 text-warning" />
                  Pending Work
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-5 w-5" style={{ color: 'var(--branch-accent)' }} />
                  <span style={{ color: 'var(--branch-accent)' }}>All Clear</span>
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {metrics.hasPendingWork ? (
              <p className="text-muted-foreground">
                There are items requiring attention. Check pending results and patient queues above.
              </p>
            ) : (
              <p className="text-muted-foreground">
                No pending lab results or waiting patients. Operations are running smoothly.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
};

export default Dashboard;

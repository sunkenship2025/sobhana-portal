import { useEffect, useMemo, useState, type ElementType } from 'react';
import { Link } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/page-header';
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
  ClipboardList,
  AlertCircle,
  Loader2,
} from 'lucide-react';

type DiagnosticVisitSummary = {
  id: string;
  branchId: string;
  status: string;
  hasReportableOrders?: boolean;
  hasExternalUploadOrders?: boolean;
  hasReportInclusionOrders?: boolean;
  hasFinalizedReport?: boolean;
  createdAt: string;
};

const Dashboard = () => {
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [diagnosticSummary, setDiagnosticSummary] = useState<{
    pending: number;
    today: number;
    finalizedToday: number;
  }>({ pending: 0, today: 0, finalizedToday: 0 });
  const [clinicSummary, setClinicSummary] = useState<{
    waitingOP: number;
    activeIP: number;
    todayOP: number;
    todayIP: number;
  }>({ waitingOP: 0, activeIP: 0, todayOP: 0, todayIP: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const fetchDashboardData = async () => {
      if (!token || !activeBranchId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(false);
      try {
        // The dashboard only needs COUNTS from the diagnostic side, so hit the
        // lightweight summary endpoint instead of pulling the whole visit list.
        // "Today" is the client's local day so the counts match the UI exactly.
        const now = new Date();
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
        const [diagnosticRes, clinicRes] = await Promise.all([
          fetch(
            `${API_BASE}/visits/diagnostic/summary?dayStart=${encodeURIComponent(dayStart)}&dayEnd=${encodeURIComponent(dayEnd)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-Branch-Id': activeBranchId,
              },
            },
          ),
          fetch(
            `${API_BASE}/visits/clinic/summary?dayStart=${encodeURIComponent(dayStart)}&dayEnd=${encodeURIComponent(dayEnd)}`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'X-Branch-Id': activeBranchId,
              },
            },
          ),
        ]);

        if (!diagnosticRes.ok || !clinicRes.ok) {
          throw new Error('Failed to fetch dashboard data');
        }

        const [diagnosticData, clinicData] = await Promise.all([
          diagnosticRes.json(),
          clinicRes.json(),
        ]);

        setDiagnosticSummary(
          diagnosticData || { pending: 0, today: 0, finalizedToday: 0 },
        );
        setClinicSummary(
          clinicData || { waitingOP: 0, activeIP: 0, todayOP: 0, todayIP: 0 },
        );
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, [token, activeBranchId, reloadKey]);

  const metrics = useMemo(() => {
    // Both diagnostic and clinic counts now come from lightweight summary endpoints
    // (computed server-side) instead of pulling the whole visit list just to count.
    return {
      pendingResultsCount: diagnosticSummary.pending,
      diagnosticsTodayCount: diagnosticSummary.today,
      finalizedTodayCount: diagnosticSummary.finalizedToday,
      waitingOP: clinicSummary.waitingOP,
      activeIP: clinicSummary.activeIP,
      todayOP: clinicSummary.todayOP,
      todayIP: clinicSummary.todayIP,
      hasPendingWork:
        diagnosticSummary.pending > 0 ||
        clinicSummary.waitingOP > 0 ||
        clinicSummary.activeIP > 0,
    };
  }, [diagnosticSummary, clinicSummary]);

  const pending = metrics.pendingResultsCount > 0;

  // Metric cards as one uniform grid of pure-stat tiles (actions live in Quick
  // Actions below). Tiling through an adaptive grid keeps every count clean.
  const metricCards: { id: string; node: JSX.Element }[] = [
    {
      id: 'pending-lab',
      node: (
        <Card key="pending-lab" className={pending ? 'border-warning/50 bg-warning/5' : ''}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              {pending && <AlertCircle className="h-4 w-4 text-warning" />}
              Pending Lab Results
            </CardTitle>
            <FlaskConical className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold ${pending ? 'text-warning' : 'text-muted-foreground'}`}>
              {metrics.pendingResultsCount}
            </div>
            <p className="text-xs text-muted-foreground">awaiting result entry</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'waiting-op',
      node: (
        <Card key="waiting-op">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              {metrics.waitingOP > 0 && <Clock className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />}
              Waiting OP Patients
            </CardTitle>
            <Stethoscope className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-muted-foreground">{metrics.waitingOP}</div>
            <p className="text-xs text-muted-foreground">in queue</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'active-ip',
      node: (
        <Card key="active-ip">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              {metrics.activeIP > 0 && <Clock className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />}
              Active IP Admissions
            </CardTitle>
            <Users className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-muted-foreground">{metrics.activeIP}</div>
            <p className="text-xs text-muted-foreground">currently admitted</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'diagnostics-today',
      node: (
        <Card key="diagnostics-today">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Diagnostics Today</CardTitle>
            <FlaskConical className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics.diagnosticsTodayCount}</div>
            <p className="text-xs text-muted-foreground">visits registered</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'reports-finalized',
      node: (
        <Card key="reports-finalized">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Reports Finalized</CardTitle>
            <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold" style={{ color: 'var(--branch-accent)' }}>
              {metrics.finalizedTodayCount}
            </div>
            <p className="text-xs text-muted-foreground">finalized today</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'today-op',
      node: (
        <Card key="today-op">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Today's OP Visits</CardTitle>
            <Stethoscope className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics.todayOP}</div>
            <p className="text-xs text-muted-foreground">registered today</p>
          </CardContent>
        </Card>
      ),
    },
    {
      id: 'today-ip',
      node: (
        <Card key="today-ip">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Today's IP Visits</CardTitle>
            <Users className="h-4 w-4" style={{ color: 'var(--branch-accent)' }} />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{metrics.todayIP}</div>
            <p className="text-xs text-muted-foreground">registered today</p>
          </CardContent>
        </Card>
      ),
    },
  ];

  // Quick Actions launchpad — the common daily jump-offs.
  const quickActions: { id: string; to: string; label: string; icon: ElementType }[] = [
    { id: 'new-diagnostic', to: '/diagnostics/new', label: 'New Diagnostic Visit', icon: FlaskConical },
    { id: 'new-clinic', to: '/clinic/new', label: 'New Clinic Visit', icon: Stethoscope },
    { id: 'enter-pending', to: '/diagnostics/pending', label: 'Enter Pending Results', icon: ClipboardList },
    { id: 'patient-360', to: '/clinic/patient-search', label: 'Patient 360', icon: Users },
    { id: 'finalized', to: '/diagnostics/finalized', label: 'Finalized Reports', icon: CheckCircle2 },
    { id: 'clinic-queue', to: '/clinic/queue', label: 'OP / IP Queue', icon: Stethoscope },
  ];

  return (
    <AppLayout context="dashboard">
      <div className="space-y-6 animate-fade-in">
        <PageHeader title="Dashboard" subtitle="Today's work at a glance" />

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading live branch data...
          </div>
        )}

        {error && !loading && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="flex flex-col items-start gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm">
                <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
                <span>Couldn't load this branch's data. Figures are hidden so nothing here reads as a false "All Clear".</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setReloadKey((k) => k + 1)}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {!error && (
          <>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              {metricCards.map((c) => c.node)}
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Quick Actions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
                  {quickActions.map((action) => {
                    const Icon = action.icon;
                    return (
                      <Button
                        key={action.id}
                        asChild
                        variant="outline"
                        className="h-auto py-4 flex-col gap-2 btn-branch-outline"
                      >
                        <Link to={action.to}>
                          <Icon className="h-6 w-6" />
                          {action.label}
                        </Link>
                      </Button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

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
          </>
        )}
      </div>
    </AppLayout>
  );
};

export default Dashboard;

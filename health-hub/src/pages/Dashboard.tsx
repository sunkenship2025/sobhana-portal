import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/appStore';
import { useBranchStore } from '@/store/branchStore';
import { Link } from 'react-router-dom';
import { 
  FlaskConical, 
  Stethoscope, 
  Users,
  Clock,
  CheckCircle2,
  ArrowRight,
  AlertCircle
} from 'lucide-react';

const Dashboard = () => {
  const { diagnosticVisits, clinicVisits, getPendingDiagnosticVisits, getFinalizedDiagnosticVisits } = useAppStore();
  const { activeBranchId } = useBranchStore();
  
  // Filter by active branch
  const branchDiagnosticVisits = diagnosticVisits.filter(v => v.branchId === activeBranchId);
  const branchClinicVisits = clinicVisits.filter(v => v.branchId === activeBranchId);
  
  const pendingResults = getPendingDiagnosticVisits().filter(v => v.branchId === activeBranchId);
  const finalizedReports = getFinalizedDiagnosticVisits().filter(v => v.branchId === activeBranchId);
  const waitingOP = branchClinicVisits.filter(v => v.visitType === 'OP' && v.status === 'WAITING');
  const waitingIP = branchClinicVisits.filter(v => v.visitType === 'IP' && v.status === 'IN_PROGRESS');
  
  const opCount = branchClinicVisits.filter(v => v.visitType === 'OP').length;
  const ipCount = branchClinicVisits.filter(v => v.visitType === 'IP').length;

  const hasPendingWork = pendingResults.length > 0 || waitingOP.length > 0 || waitingIP.length > 0;

  return (
    <AppLayout context="dashboard">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground">Today's work at a glance</p>
        </div>

        {/* TIER 1: Immediate Work - Pending Items */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card className={pendingResults.length > 0 ? "border-warning/50 bg-warning/5" : ""}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {pendingResults.length > 0 && <AlertCircle className="h-4 w-4 text-warning" />}
                Pending Lab Results
              </CardTitle>
              <FlaskConical className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${pendingResults.length > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                {pendingResults.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">awaiting result entry</p>
              <Button asChild size="sm" variant={pendingResults.length > 0 ? "default" : "outline"}>
                <Link to="/diagnostics/pending">
                  Enter Results <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className={waitingOP.length > 0 ? "border-context-clinic/50 bg-context-clinic/5" : ""}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {waitingOP.length > 0 && <Clock className="h-4 w-4 text-context-clinic" />}
                Waiting OP Patients
              </CardTitle>
              <Stethoscope className="h-4 w-4 text-context-clinic" />
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${waitingOP.length > 0 ? 'text-context-clinic' : 'text-muted-foreground'}`}>
                {waitingOP.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">in queue</p>
              <Button asChild size="sm" variant={waitingOP.length > 0 ? "secondary" : "outline"}>
                <Link to="/clinic/queue">
                  View Queue <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className={waitingIP.length > 0 ? "border-context-clinic/50 bg-context-clinic/5" : ""}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                {waitingIP.length > 0 && <Clock className="h-4 w-4 text-context-clinic" />}
                Active IP Admissions
              </CardTitle>
              <Users className="h-4 w-4 text-context-clinic" />
            </CardHeader>
            <CardContent>
              <div className={`text-3xl font-bold ${waitingIP.length > 0 ? 'text-context-clinic' : 'text-muted-foreground'}`}>
                {waitingIP.length}
              </div>
              <p className="text-xs text-muted-foreground mb-3">currently admitted</p>
              <Button asChild size="sm" variant={waitingIP.length > 0 ? "secondary" : "outline"}>
                <Link to="/clinic/queue">
                  View Admissions <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Quick Actions - Primary CTAs */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <Button asChild className="h-auto py-4 flex-col gap-2">
                <Link to="/diagnostics/new">
                  <FlaskConical className="h-6 w-6" />
                  New Diagnostic Visit
                </Link>
              </Button>
              <Button asChild variant="secondary" className="h-auto py-4 flex-col gap-2">
                <Link to="/clinic/new">
                  <Stethoscope className="h-6 w-6" />
                  New Clinic Visit
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2">
                <Link to="/diagnostics/pending">
                  <Clock className="h-6 w-6" />
                  Enter Results
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-auto py-4 flex-col gap-2">
                <Link to="/clinic/queue">
                  <Users className="h-6 w-6" />
                  Visit Queue
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* TIER 2: Today's Summary Counts */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Today's OP Visits
              </CardTitle>
              <Stethoscope className="h-4 w-4 text-context-clinic" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{opCount}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Today's IP Visits
              </CardTitle>
              <Users className="h-4 w-4 text-context-clinic" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{ipCount}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Diagnostics Today
              </CardTitle>
              <FlaskConical className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{branchDiagnosticVisits.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Reports Finalized
              </CardTitle>
              <CheckCircle2 className="h-4 w-4 text-success" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-success">{finalizedReports.length}</div>
            </CardContent>
          </Card>
        </div>

        {/* Operational Health Status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {hasPendingWork ? (
                <>
                  <AlertCircle className="h-5 w-5 text-warning" />
                  Pending Work
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-5 w-5 text-success" />
                  All Clear
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hasPendingWork ? (
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

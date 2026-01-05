import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/appStore';
import { Link } from 'react-router-dom';
import { 
  FlaskConical, 
  Stethoscope, 
  TrendingUp, 
  Users,
  Clock,
  CheckCircle2,
  ArrowRight,
  Building2
} from 'lucide-react';

const OwnerDashboard = () => {
  const { diagnosticVisits, clinicVisits, getPendingDiagnosticVisits, getFinalizedDiagnosticVisits } = useAppStore();
  
  const pendingResults = getPendingDiagnosticVisits().length;
  const finalizedReports = getFinalizedDiagnosticVisits().length;
  const opVisits = clinicVisits.filter(v => v.visitType === 'OP').length;
  const ipVisits = clinicVisits.filter(v => v.visitType === 'IP').length;
  
  const diagnosticsRevenue = diagnosticVisits.reduce((sum, v) => sum + v.totalAmount, 0);
  const clinicRevenue = clinicVisits.reduce((sum, v) => sum + v.consultationFee, 0);
  const totalRevenue = diagnosticsRevenue + clinicRevenue;

  return (
    <AppLayout context="owner">
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-3">
          <Building2 className="h-8 w-8 text-context-owner" />
          <div>
            <h1 className="text-2xl font-bold">Owner Dashboard</h1>
            <p className="text-muted-foreground">How is the business doing today?</p>
          </div>
        </div>

        {/* Today Overview */}
        <Card>
          <CardHeader>
            <CardTitle>Today Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 md:grid-cols-3">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                <div className="p-3 rounded-full bg-context-clinic/10">
                  <Stethoscope className="h-6 w-6 text-context-clinic" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Clinic OP</p>
                  <p className="text-3xl font-bold">{opVisits}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                <div className="p-3 rounded-full bg-context-clinic/10">
                  <Users className="h-6 w-6 text-context-clinic" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Clinic IP</p>
                  <p className="text-3xl font-bold">{ipVisits}</p>
                </div>
              </div>
              
              <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                <div className="p-3 rounded-full bg-primary/10">
                  <FlaskConical className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Diagnostics</p>
                  <p className="text-3xl font-bold">{diagnosticVisits.length}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Revenue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-success" />
              Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="p-6 rounded-lg border bg-card">
                <p className="text-sm text-muted-foreground mb-1">Clinic</p>
                <p className="text-3xl font-bold">₹{clinicRevenue.toLocaleString()}</p>
              </div>
              <div className="p-6 rounded-lg border bg-card">
                <p className="text-sm text-muted-foreground mb-1">Diagnostics</p>
                <p className="text-3xl font-bold">₹{diagnosticsRevenue.toLocaleString()}</p>
              </div>
              <div className="p-6 rounded-lg bg-success/10 border border-success/30">
                <p className="text-sm text-muted-foreground mb-1">Total</p>
                <p className="text-3xl font-bold text-success">₹{totalRevenue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Operational Health */}
        <Card>
          <CardHeader>
            <CardTitle>Operational Health</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex items-center justify-between p-4 rounded-lg border">
                <div className="flex items-center gap-3">
                  <Clock className="h-8 w-8 text-warning" />
                  <div>
                    <p className="font-medium">Pending Lab Results</p>
                    <p className="text-sm text-muted-foreground">Awaiting result entry</p>
                  </div>
                </div>
                <div className="text-3xl font-bold text-warning">{pendingResults}</div>
              </div>
              
              <div className="flex items-center justify-between p-4 rounded-lg border">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="h-8 w-8 text-success" />
                  <div>
                    <p className="font-medium">Reports Finalized</p>
                    <p className="text-sm text-muted-foreground">Completed today</p>
                  </div>
                </div>
                <div className="text-3xl font-bold text-success">{finalizedReports}</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick Navigation */}
        <div className="grid gap-4 md:grid-cols-2">
          <Button asChild size="lg" className="h-auto py-4">
            <Link to="/clinic/queue" className="flex items-center justify-between w-full">
              <span className="flex items-center gap-3">
                <Stethoscope className="h-5 w-5" />
                Go to Clinic
              </span>
              <ArrowRight className="h-5 w-5" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline" className="h-auto py-4">
            <Link to="/diagnostics/pending" className="flex items-center justify-between w-full">
              <span className="flex items-center gap-3">
                <FlaskConical className="h-5 w-5" />
                Go to Diagnostics
              </span>
              <ArrowRight className="h-5 w-5" />
            </Link>
          </Button>
        </div>
      </div>
    </AppLayout>
  );
};

export default OwnerDashboard;

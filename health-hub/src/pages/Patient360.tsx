/**
 * Patient 360 — Canonical Patient View
 * 
 * This is the single, authoritative screen that shows the complete medical
 * and financial history of a patient across all branches, domains, and time.
 * 
 * INVARIANTS:
 * - This view is READ-ONLY
 * - Patient is GLOBAL (exists once in the system)
 * - Visits are BRANCH-SCOPED (displayed but not editable here)
 * - Reports viewable only if FINALIZED
 */

import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/components/layout/AppLayout';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  User, 
  Phone, 
  MapPin,
  Calendar,
  ArrowLeft,
  Lock,
  Building2
} from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { VisitTimeline } from '@/components/patient360/VisitTimeline';
import { FinancialSummary } from '@/components/patient360/FinancialSummary';
import type { Patient360View } from '@/types';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

async function fetchPatient360(patientId: string, token: string): Promise<Patient360View> {
  const res = await fetch(`${API_BASE}/patients/${patientId}/360`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.message || 'Failed to fetch patient data');
  }
  
  return res.json();
}

export default function Patient360() {
  const { patientId } = useParams<{ patientId: string }>();
  const navigate = useNavigate();
  const { token } = useAuthStore();

  const { data: patient360, isLoading, error } = useQuery({
    queryKey: ['patient360', patientId],
    queryFn: () => fetchPatient360(patientId!, token!),
    enabled: !!patientId && !!token,
    staleTime: 30000, // 30 seconds
  });

  if (isLoading) {
    return (
      <AppLayout context="dashboard">
        <div className="space-y-6 animate-fade-in">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </AppLayout>
    );
  }

  if (error || !patient360) {
    return (
      <AppLayout context="dashboard">
        <div className="space-y-6">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Go Back
          </Button>
          <Card>
            <CardContent className="pt-6">
              <p className="text-destructive">
                {error instanceof Error ? error.message : 'Failed to load patient data'}
              </p>
            </CardContent>
          </Card>
        </div>
      </AppLayout>
    );
  }

  const { patient, visits, financialSummary, branchesVisited } = patient360;

  return (
    <AppLayout context="dashboard">
      <div className="space-y-6 animate-fade-in">
        {/* Back Navigation */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back
          </Button>
          
          {/* Read-Only Indicator */}
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Lock className="h-4 w-4" />
            <span>Patient 360 · Global Read-Only History</span>
          </div>
        </div>

        {/* SECTION A: Patient Header (Identity Block) - Sticky */}
        <Card className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
              {/* Patient Identity */}
              <div className="flex items-start gap-4">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-foreground">{patient.name}</h1>
                  <p className="text-muted-foreground font-mono text-sm">{patient.patientNumber}</p>
                  <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
                    <span>{patient.age} years</span>
                    <span>•</span>
                    <span>{patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}</span>
                  </div>
                </div>
              </div>

              {/* Contact Info */}
              <div className="flex flex-col gap-2 text-sm">
                {patient.primaryPhone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="h-4 w-4" />
                    <span>{patient.primaryPhone}</span>
                  </div>
                )}
                {patient.address && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <MapPin className="h-4 w-4" />
                    <span className="max-w-[200px] truncate">{patient.address}</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span>Registered {new Date(patient.createdAt).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Branches Visited */}
              {branchesVisited.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    Branches visited
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {branchesVisited.map((branch) => (
                      <Badge key={branch.id} variant="outline" className="text-xs">
                        {branch.code}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* SECTION D: Financial Summary (Read-Only, Informational) */}
        <FinancialSummary summary={financialSummary} />

        {/* SECTION B: Visit Timeline (Primary Section) */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Visit History</h2>
              <span className="text-sm text-muted-foreground">
                {visits.length} total visit{visits.length !== 1 ? 's' : ''}
              </span>
            </div>
            
            {visits.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                No visits recorded yet
              </p>
            ) : (
              <VisitTimeline 
                visits={visits} 
                patientId={patient.id}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

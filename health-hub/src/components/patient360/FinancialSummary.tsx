/**
 * Financial Summary Component
 * 
 * Read-only informational summary of patient's financial data.
 * 
 * RULES:
 * - Statement-like, not actionable
 * - No editing, no refunds, no controls
 * - Aggregated totals only
 */

import { Card, CardContent } from '@/components/ui/card';
import { FlaskConical, Stethoscope, CreditCard, Clock } from 'lucide-react';
import type { PatientFinancialSummary } from '@/types';

interface FinancialSummaryProps {
  summary: PatientFinancialSummary;
}

export function FinancialSummary({ summary }: FinancialSummaryProps) {
  const formatAmount = (paise: number) => {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  const totalBilled = summary.totalDiagnosticsBilledInPaise + summary.totalClinicBilledInPaise;

  return (
    <div className="grid gap-4 md:grid-cols-4">
      {/* Diagnostics Total */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FlaskConical className="h-4 w-4 text-primary" />
              <span className="text-sm">Diagnostics</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {summary.visitCount.diagnostics} visit{summary.visitCount.diagnostics !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-2xl font-bold mt-2">
            {formatAmount(summary.totalDiagnosticsBilledInPaise)}
          </p>
        </CardContent>
      </Card>

      {/* Clinic Total */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Stethoscope className="h-4 w-4 text-context-clinic" />
              <span className="text-sm">Clinic</span>
            </div>
            <span className="text-xs text-muted-foreground">
              {summary.visitCount.clinic} visit{summary.visitCount.clinic !== 1 ? 's' : ''}
            </span>
          </div>
          <p className="text-2xl font-bold mt-2">
            {formatAmount(summary.totalClinicBilledInPaise)}
          </p>
        </CardContent>
      </Card>

      {/* Total Paid */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <CreditCard className="h-4 w-4 text-green-600" />
            <span className="text-sm">Total Paid</span>
          </div>
          <p className="text-2xl font-bold mt-2 text-green-600">
            {formatAmount(summary.totalPaidInPaise)}
          </p>
        </CardContent>
      </Card>

      {/* Outstanding */}
      <Card className={summary.totalPendingInPaise > 0 ? 'border-yellow-500/50' : ''}>
        <CardContent className="pt-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="text-sm">Outstanding</span>
          </div>
          <p className={`text-2xl font-bold mt-2 ${summary.totalPendingInPaise > 0 ? 'text-yellow-600' : 'text-muted-foreground'}`}>
            {formatAmount(summary.totalPendingInPaise)}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

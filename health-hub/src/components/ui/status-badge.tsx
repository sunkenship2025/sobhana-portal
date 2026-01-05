import { cn } from '@/lib/utils';
import type { PaymentStatus, DiagnosticVisitStatus, ClinicVisitStatus } from '@/types';

interface StatusBadgeProps {
  status: PaymentStatus | DiagnosticVisitStatus | ClinicVisitStatus | string;
  className?: string;
}

const statusStyles: Record<string, string> = {
  // Payment Status
  PAID: 'status-paid',
  PENDING: 'status-pending',
  
  // Diagnostic Visit Status
  RESULTS_PENDING: 'status-pending',
  DRAFT: 'status-draft',
  FINALIZED: 'status-finalized',
  
  // Clinic Visit Status
  WAITING: 'status-pending',
  IN_PROGRESS: 'status-draft',
  COMPLETED: 'status-finalized',
};

const statusLabels: Record<string, string> = {
  PAID: 'Paid',
  PENDING: 'Pending',
  RESULTS_PENDING: 'Results Pending',
  DRAFT: 'Draft',
  FINALIZED: 'Finalized',
  WAITING: 'Waiting',
  IN_PROGRESS: 'In Progress',
  COMPLETED: 'Completed',
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span className={cn('status-badge', statusStyles[status], className)}>
      {statusLabels[status] || status}
    </span>
  );
}

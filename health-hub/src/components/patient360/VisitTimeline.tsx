/**
 * Visit Timeline Component
 * 
 * Displays a chronological table of all visits across all branches.
 * Each row represents a single visit (the anchor entity).
 * 
 * RULES:
 * - Sorted newest → oldest
 * - View Report appears ONLY if domain=Diagnostics AND report is FINALIZED
 * - Clicking a row opens Visit Detail drawer (does not navigate away)
 */

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { 
  FlaskConical, 
  Stethoscope,
  FileText,
  Lock,
  ChevronRight
} from 'lucide-react';
import { VisitDetailDrawer } from './VisitDetailDrawer';
import type { VisitTimelineItem } from '@/types';

interface VisitTimelineProps {
  visits: VisitTimelineItem[];
  patientId: string;
}

export function VisitTimeline({ visits, patientId }: VisitTimelineProps) {
  const [selectedVisit, setSelectedVisit] = useState<VisitTimelineItem | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleViewVisit = (visit: VisitTimelineItem) => {
    setSelectedVisit(visit);
    setDrawerOpen(true);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const formatAmount = (paise: number) => {
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  const getDomainIcon = (domain: string) => {
    if (domain === 'DIAGNOSTICS') {
      return <FlaskConical className="h-4 w-4 text-primary" />;
    }
    return <Stethoscope className="h-4 w-4 text-context-clinic" />;
  };

  const getDomainLabel = (visit: VisitTimelineItem) => {
    if (visit.domain === 'DIAGNOSTICS') {
      return 'Diagnostics';
    }
    return `Clinic (${visit.visitType})`;
  };

  const getStatusBadge = (visit: VisitTimelineItem) => {
    const status = visit.status;
    
    // For diagnostics, check report status
    if (visit.domain === 'DIAGNOSTICS') {
      if (visit.reportFinalized) {
        return <Badge variant="default" className="bg-green-600">Report Finalized</Badge>;
      }
      if (visit.hasReport) {
        return <Badge variant="secondary">In Progress</Badge>;
      }
      return <Badge variant="outline">Draft</Badge>;
    }
    
    // For clinic visits
    switch (status) {
      case 'COMPLETED':
        return <Badge variant="default" className="bg-green-600">Completed</Badge>;
      case 'IN_PROGRESS':
        return <Badge variant="secondary">In Progress</Badge>;
      case 'WAITING':
        return <Badge variant="outline">Waiting</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getPaymentBadge = (visit: VisitTimelineItem) => {
    if (visit.paymentStatus === 'PAID') {
      return <Badge variant="outline" className="text-green-600 border-green-600">Paid</Badge>;
    }
    return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Pending</Badge>;
  };

  /**
   * View Report Rule (Critical Safety):
   * Show only if:
   * - Visit domain = DIAGNOSTICS
   * - Report exists
   * - Latest report version = FINALIZED
   */
  const canViewReport = (visit: VisitTimelineItem) => {
    return visit.domain === 'DIAGNOSTICS' && visit.hasReport && visit.reportFinalized;
  };

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">Date</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Bill No</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="w-[120px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visits.map((visit) => (
              <TableRow 
                key={visit.visitId}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => handleViewVisit(visit)}
              >
                <TableCell className="font-medium">
                  {formatDate(visit.visitDate)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {getDomainIcon(visit.domain)}
                    <span>{getDomainLabel(visit)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {visit.branchCode}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {visit.billNumber}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    {getStatusBadge(visit)}
                    {getPaymentBadge(visit)}
                  </div>
                </TableCell>
                <TableCell className="text-right font-semibold">
                  {formatAmount(visit.totalAmountInPaise)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    {canViewReport(visit) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-primary"
                        onClick={() => {
                          // Navigate to report preview
                          window.open(`/diagnostics/preview/${visit.visitId}`, '_blank');
                        }}
                      >
                        <Lock className="h-3 w-3 mr-1" />
                        <FileText className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleViewVisit(visit)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Visit Detail Drawer */}
      <VisitDetailDrawer
        visit={selectedVisit}
        patientId={patientId}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </>
  );
}

/**
 * BillResolveCard — the resolved `/patients/by-bill/:billNumber` result.
 *
 * An accented (border-l-4) card: bill header + payment StatusBadge, the patient
 * identity row, and two actions — Open visit (deep-links to the visit in the
 * detail timeline via ?visit=) and Open record (the patient detail page). This
 * is distinct from a patient match: a bill uniquely identifies one visit.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Receipt, FileText, ChevronRight } from "lucide-react";
import { formatCurrency, formatPatientName } from "@/lib/patientDisplay";
import type { BillLookupResult, VisitDomain } from "@/types";

function getDomainLabel(domain: VisitDomain): string {
  return domain === "DIAGNOSTICS" ? "Diagnostic visit" : "Clinic visit";
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface BillResolveCardProps {
  result: BillLookupResult;
  onOpenVisit: (patientId: string, visitId: string) => void;
  onOpenRecord: (patientId: string) => void;
}

export function BillResolveCard({
  result,
  onOpenVisit,
  onOpenRecord,
}: BillResolveCardProps) {
  const { patient, visit } = result;
  const ageGender = [patient.ageDisplay, patient.gender].filter(Boolean).join(" · ");
  const phone = patient.identifiers?.find((i) => i.type === "PHONE")?.value;

  return (
    <Card className="overflow-hidden border-l-4 border-l-primary">
      <CardContent className="space-y-4 p-4">
        {/* Bill header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="font-mono font-semibold text-foreground">
              {visit.billNumber || "—"}
            </span>
            <span className="text-sm text-muted-foreground">
              {getDomainLabel(visit.domain)} · {visit.branchName} ·{" "}
              {formatDate(visit.createdAt)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-medium tabular-nums">
              {formatCurrency(visit.totalAmountInPaise)}
            </span>
            {visit.paymentStatus && <StatusBadge status={visit.paymentStatus} />}
          </div>
        </div>

        {/* Identity row */}
        <div className="rounded-lg bg-muted/50 p-3 text-sm">
          <span className="font-medium text-foreground">
            {formatPatientName(patient.name, patient.title)}
          </span>
          {ageGender && <span className="text-muted-foreground"> · {ageGender}</span>}
          <span className="text-muted-foreground"> · {patient.patientNumber}</span>
          {phone && <span className="text-muted-foreground"> · {phone}</span>}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            className="w-full sm:w-auto"
            onClick={() => onOpenVisit(patient.id, visit.visitId)}
          >
            Open visit
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => onOpenRecord(patient.id)}
          >
            <FileText className="mr-2 h-4 w-4" />
            Open patient record
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * PatientMatchCard — one `PatientSearchResult` in the smart-search results list.
 *
 * Renders initials, formatted name, age·gender chip, patientNumber, a compact
 * history/meta line, and an Open button. Shared-phone disambiguation safeguard:
 * always surfaces name + patientNumber + age·gender so two patients on the same
 * number are visually distinct and Open routes to the correct patientId.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye } from "lucide-react";
import { formatPatientName } from "@/lib/patientDisplay";
import type { PatientSearchResult, VisitDomain, VisitType } from "@/types";

function getDomainLabel(domain: VisitDomain, visitType?: VisitType): string {
  if (domain === "DIAGNOSTICS") return "Diagnostic";
  return visitType === "IP" ? "Clinic IP" : "Clinic OP";
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function initialsOf(name: string): string {
  const parts = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface PatientMatchCardProps {
  result: PatientSearchResult;
  onOpen: (patientId: string) => void;
}

export function PatientMatchCard({ result, onOpen }: PatientMatchCardProps) {
  const { patient } = result;
  const phone = patient.identifiers?.find((i) => i.type === "PHONE")?.value;
  const ageGender = [patient.ageDisplay || (patient.age ? `${patient.age}y` : null), patient.gender]
    .filter(Boolean)
    .join(" · ");
  const latest = result.historySnapshot?.[0];

  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
            aria-hidden="true"
          >
            {initialsOf(patient.name)}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium text-foreground">
                {formatPatientName(patient.name, patient.title)}
              </span>
              {ageGender && (
                <Badge variant="secondary" className="text-xs font-normal">
                  {ageGender}
                </Badge>
              )}
              <Badge variant="outline" className="text-xs font-normal">
                {patient.patientNumber}
              </Badge>
            </div>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              {phone ? `${phone}` : "No phone on file"}
              {latest && (
                <>
                  {" · "}
                  {getDomainLabel(latest.domain, latest.visitType)} ·{" "}
                  {latest.branchName} · {formatDate(latest.createdAt)}
                </>
              )}
              {result.totalVisits > 0 && (
                <>
                  {" · "}
                  {result.totalVisits} visit{result.totalVisits === 1 ? "" : "s"}
                </>
              )}
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          className="w-full shrink-0 sm:w-auto"
          onClick={() => onOpen(patient.id)}
        >
          <Eye className="mr-2 h-4 w-4" />
          Open
        </Button>
      </CardContent>
    </Card>
  );
}

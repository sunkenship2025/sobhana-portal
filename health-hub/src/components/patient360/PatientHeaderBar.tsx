/**
 * PatientHeaderBar — sticky identity bar (§2, §8).
 *
 * Back button, formatted name, identity chips (patientNumber · age·gender ·
 * phone), branch-count, and the Edit trigger (hosts PatientEditDialog, which
 * renders its own Pencil button). Sticky so identity stays visible while the
 * timeline scrolls.
 */
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import { PatientEditDialog } from "./PatientEditDialog";
import { formatPatientName } from "@/lib/patientDisplay";
import type { Patient } from "@/types";

interface PatientHeaderBarProps {
  patient: Patient;
  branchCount: number;
  onBack: () => void;
  /** Called with the updated patient after a successful edit. Cache refresh is
   *  handled inside usePatientIdentityEdit (scoped summary invalidation, §3.4),
   *  so this is purely a notification hook for the host. */
  onPatientUpdated: (updated: Patient) => void;
}

export function PatientHeaderBar({
  patient,
  branchCount,
  onBack,
  onPatientUpdated,
}: PatientHeaderBarProps) {
  const phone = patient.identifiers?.find((i) => i.type === "PHONE")?.value;
  const genderLabel =
    patient.gender === "M" ? "Male" : patient.gender === "F" ? "Female" : "Other";
  const ageGender = [patient.ageDisplay || (patient.age ? `${patient.age}y` : null), genderLabel]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="sticky top-0 z-20 -mx-4 border-b bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
          <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Back
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-bold sm:text-xl">
              {formatPatientName(patient.name, patient.title)}
            </h1>
            <Badge variant="outline" className="font-mono text-xs font-normal">
              {patient.patientNumber}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            {ageGender}
            {phone ? ` · ${phone}` : ""}
            {branchCount > 0 && (
              <>
                {" · "}
                {branchCount} branch{branchCount === 1 ? "" : "es"}
              </>
            )}
          </p>
        </div>

        <div className="shrink-0">
          <PatientEditDialog patient={patient} onSuccess={onPatientUpdated} />
        </div>
      </div>
    </div>
  );
}

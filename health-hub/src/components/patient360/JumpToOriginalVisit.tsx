/**
 * JumpToOriginalVisit — revisit annotation + in-page jump (§2, §4).
 *
 * Clinic revisits reference an earlier billed visit. There is NO /visit/:id
 * route, so the jump is in-page only: clicking runs the orchestrator's bounded
 * auto-locate routine for the original visitId.
 */
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

interface JumpToOriginalVisitProps {
  originalVisitId: string;
  originalVisitVisitRef?: string | null;
  originalVisitBillNumber?: string | null;
  originalVisitDate?: Date | string | null;
  onJump: (visitId: string) => void;
}

export function JumpToOriginalVisit({
  originalVisitId,
  originalVisitVisitRef,
  originalVisitBillNumber,
  originalVisitDate,
  onJump,
}: JumpToOriginalVisitProps) {
  const label =
    originalVisitBillNumber
      ? `Bill #${originalVisitBillNumber}`
      : originalVisitVisitRef
        ? `Ref ${originalVisitVisitRef}`
        : "original visit";

  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 text-xs text-blue-700"
      onClick={(e) => {
        e.stopPropagation();
        onJump(originalVisitId);
      }}
    >
      <span>
        Original billed visit: {label}
        {originalVisitDate ? ` on ${formatDate(originalVisitDate)}` : ""}
      </span>
      <ChevronRight className="ml-0.5 h-3 w-3" aria-hidden="true" />
    </Button>
  );
}

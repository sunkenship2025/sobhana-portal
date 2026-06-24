/**
 * NoMatchRegister — empty search result OR a bill-404.
 *
 * For a patient miss (`[]` from /search) this offers Register, which carries the
 * typed value into the new-visit flow (Group C step 14b reader). For a bill miss
 * it shows a distinct "No bill found" message and only offers Try again — a bill
 * miss is NOT a patient-register path.
 */
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { SearchX, UserPlus } from "lucide-react";
import type { SearchKind } from "@/types";

interface NoMatchRegisterProps {
  typed: string;
  kind: SearchKind;
  onRegister: () => void;
  onClear: () => void;
}

export function NoMatchRegister({
  typed,
  kind,
  onRegister,
  onClear,
}: NoMatchRegisterProps) {
  // A bill miss is distinct: there is no "register a bill" action.
  if (kind === "bill") {
    return (
      <EmptyState
        icon={SearchX}
        title={`No bill found for ${typed}`}
        description="Check the bill number and try again."
        action={
          <Button variant="outline" onClick={onClear}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      icon={SearchX}
      title="No matching patient"
      description={
        typed
          ? `Nothing matched "${typed}". Register a new patient or try a different search.`
          : "Register a new patient or try a different search."
      }
      action={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button onClick={onRegister}>
            <UserPlus className="mr-2 h-4 w-4" />
            Register new patient
          </Button>
          <Button variant="outline" onClick={onClear}>
            Try again
          </Button>
        </div>
      }
    />
  );
}

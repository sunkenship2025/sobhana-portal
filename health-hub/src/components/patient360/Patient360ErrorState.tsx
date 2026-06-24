/**
 * Patient360ErrorState — 404 not-found vs network/5xx error (§6).
 *
 * The caller branches on ApiError.status (summary uses retry:false so a real 404
 * surfaces instantly):
 *  - 'not-found' → EmptyState + "Back to Search" (no Retry).
 *  - 'network'   → destructive Alert + "Retry" → query.refetch().
 */
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { AlertCircle, ArrowLeft, RotateCcw, UserX } from "lucide-react";

interface Patient360ErrorStateProps {
  kind: "not-found" | "network";
  onRetry?: () => void;
  onBack: () => void;
}

export function Patient360ErrorState({ kind, onRetry, onBack }: Patient360ErrorStateProps) {
  if (kind === "not-found") {
    return (
      <EmptyState
        icon={UserX}
        title="Patient not found"
        description="This patient record doesn't exist or may have been removed."
        action={
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
            Back to search
          </Button>
        }
      />
    );
  }

  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Couldn't load this patient</AlertTitle>
      <AlertDescription className="mt-2 flex flex-wrap items-center gap-3">
        <span>Check your connection and try again.</span>
        <div className="flex items-center gap-2">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Retry
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onBack}>
            Back to search
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

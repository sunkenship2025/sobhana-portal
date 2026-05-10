/**
 * Destructive confirm for payout delete (single + bulk).
 *
 * Matches the AlertDialog pattern used in ManageSigningDoctors.tsx — same
 * shape, same wording style ("This action cannot be undone").
 *
 * Owner-only — the parent component is responsible for hiding the trigger
 * for staff. This dialog itself doesn't role-check.
 */
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface PayoutDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number; // number of payouts to be deleted (1+ for bulk, 1 for single)
  busy?: boolean;
  onConfirm: () => Promise<void> | void;
}

export function PayoutDeleteDialog({
  open,
  onOpenChange,
  count,
  busy = false,
  onConfirm,
}: PayoutDeleteDialogProps) {
  const noun = count === 1 ? "payout" : "payouts";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {count === 1 ? "this payout" : `${count} ${noun}`}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. The {noun} will be removed from the
            list, summaries, exports, and the doctor's history — for both
            owner and staff.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              if (!busy) onConfirm();
            }}
            disabled={busy}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting…
              </>
            ) : (
              `Delete ${count === 1 ? "" : count + " "}${noun}`
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

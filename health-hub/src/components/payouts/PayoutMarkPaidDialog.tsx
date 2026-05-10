/**
 * Single source of truth for Mark Paid (single + bulk).
 *
 * Replaces the duplicate dialogs that previously lived in PayoutsList.tsx
 * and PayoutDetail.tsx. Inconsistencies fixed:
 *   - Notes is always a Textarea
 *   - Reference ID label includes "(Optional)"
 *   - Payment Method has a required asterisk
 *   - Last-used method is remembered via payoutPrefsStore
 *
 * Bulk mode applies ONE payment record to ALL selected rows. The caller
 * passes either a single `payout` (for context) or `bulkCount + bulkAmount`.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PaymentType, PayoutSummary } from "@/types";
import { formatRupees } from "@/lib/payoutFormatters";
import { usePayoutPrefs } from "@/store/payoutPrefsStore";

export interface PayoutMarkPaidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  // Single mode: pass the payout for context. Bulk mode: pass count + total.
  payout?: PayoutSummary | null;
  bulkCount?: number;
  bulkTotalInPaise?: number;
  onConfirm: (payment: {
    paymentMethod: PaymentType;
    paymentReferenceId?: string;
    notes?: string;
  }) => Promise<void> | void;
}

export function PayoutMarkPaidDialog({
  open,
  onOpenChange,
  busy = false,
  payout,
  bulkCount,
  bulkTotalInPaise,
  onConfirm,
}: PayoutMarkPaidDialogProps) {
  const { lastPaymentMethod, setLastPaymentMethod } = usePayoutPrefs();
  const [paymentMethod, setPaymentMethod] = useState<PaymentType>(lastPaymentMethod);
  const [paymentReferenceId, setPaymentReferenceId] = useState("");
  const [notes, setNotes] = useState("");

  const isBulk = (bulkCount ?? 0) > 0;

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setPaymentMethod(lastPaymentMethod);
      setPaymentReferenceId("");
      setNotes("");
    }
  }, [open, lastPaymentMethod]);

  const handleConfirm = async () => {
    setLastPaymentMethod(paymentMethod);
    await onConfirm({
      paymentMethod,
      paymentReferenceId: paymentReferenceId.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isBulk ? `Mark ${bulkCount} payouts as paid` : "Mark payout as paid"}
          </DialogTitle>
          <DialogDescription>
            {isBulk
              ? "One payment record will be applied to all selected payouts. Each row records its own paidAt timestamp."
              : "Once marked paid, this payout cannot be modified."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Context block */}
          {isBulk ? (
            <div className="rounded-lg bg-muted p-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Payouts</span>
                <span className="font-medium">{bulkCount}</span>
              </div>
              <div className="mt-2 flex justify-between gap-3">
                <span className="text-muted-foreground">Total amount</span>
                <span className="font-semibold">
                  {formatRupees(bulkTotalInPaise ?? 0)}
                </span>
              </div>
            </div>
          ) : payout ? (
            <div className="rounded-lg bg-muted p-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Doctor</span>
                <span className="font-medium text-right">{payout.doctorName}</span>
              </div>
              <div className="mt-2 flex justify-between gap-3">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold">
                  {formatRupees(payout.derivedAmountInPaise)}
                </span>
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="pay-method">
              Payment Method <span className="text-destructive">*</span>
            </Label>
            <Select
              value={paymentMethod}
              onValueChange={(v) => setPaymentMethod(v as PaymentType)}
            >
              <SelectTrigger id="pay-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASH">Cash</SelectItem>
                <SelectItem value="ONLINE">Online Transfer</SelectItem>
                <SelectItem value="CHEQUE">Cheque</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Reference ID (Optional)</Label>
            <Input
              id="pay-ref"
              placeholder={
                paymentMethod === "CHEQUE" ? "Cheque number" : "Transaction ID"
              }
              value={paymentReferenceId}
              onChange={(e) => setPaymentReferenceId(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pay-notes">Notes (Optional)</Label>
            <Textarea
              id="pay-notes"
              placeholder="Any additional notes about this payment"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing…
              </>
            ) : (
              "Confirm Payment"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

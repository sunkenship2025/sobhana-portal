/**
 * Single source of truth for Mark Paid (single + bulk + pay-all review).
 *
 * Bulk mode applies ONE payment record to ALL selected rows. When the caller
 * passes the inbound/outbound split (commissionsInPaise / labPayablesInPaise),
 * the context block becomes a Review breakdown so "Pay all" is never a surprise.
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

export interface PayoutMarkPaidPayment {
  paymentMethod: PaymentType;
  paymentReferenceId?: string;
  notes?: string;
  paidOn?: string;
}

export interface PayoutMarkPaidDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy?: boolean;
  title?: string;
  // Single mode: pass the payout for context. Bulk mode: pass count + total.
  payout?: PayoutSummary | null;
  bulkCount?: number;
  bulkTotalInPaise?: number;
  // Optional review split (bulk): when set, shows commissions vs lab-payables.
  commissionsInPaise?: number;
  labPayablesInPaise?: number;
  // Optional per-type review (bulk): when set, itemizes every payee type being
  // paid so nothing collapsed/hidden is settled unannounced. Takes precedence.
  breakdown?: { label: string; amountInPaise: number; count: number; outbound?: boolean }[];
  // Single mode: lets the owner open the full statement to verify before paying.
  onViewStatement?: () => void;
  onConfirm: (payment: PayoutMarkPaidPayment) => Promise<void> | void;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function fmtPeriod(s: string): string {
  return new Date(s).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function PayoutMarkPaidDialog({
  open,
  onOpenChange,
  busy = false,
  title,
  payout,
  bulkCount,
  bulkTotalInPaise,
  commissionsInPaise,
  labPayablesInPaise,
  breakdown,
  onViewStatement,
  onConfirm,
}: PayoutMarkPaidDialogProps) {
  const { lastPaymentMethod, setLastPaymentMethod } = usePayoutPrefs();
  const [paymentMethod, setPaymentMethod] = useState<PaymentType>(lastPaymentMethod);
  const [paymentReferenceId, setPaymentReferenceId] = useState("");
  const [notes, setNotes] = useState("");
  const [paidOn, setPaidOn] = useState(todayStr());

  const isBulk = (bulkCount ?? 0) > 0;
  const hasSplit = commissionsInPaise !== undefined || labPayablesInPaise !== undefined;

  useEffect(() => {
    if (open) {
      setPaymentMethod(lastPaymentMethod);
      setPaymentReferenceId("");
      setNotes("");
      setPaidOn(todayStr());
    }
  }, [open, lastPaymentMethod]);

  const handleConfirm = async () => {
    setLastPaymentMethod(paymentMethod);
    await onConfirm({
      paymentMethod,
      paymentReferenceId: paymentReferenceId.trim() || undefined,
      notes: notes.trim() || undefined,
      paidOn: paidOn || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {title ?? (isBulk ? `Mark ${bulkCount} payouts as paid` : "Mark payout as paid")}
          </DialogTitle>
          <DialogDescription>
            {isBulk
              ? "One payment record applies to all selected payouts; each records its own paid time."
              : "Once marked paid, this payout cannot be modified."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Context / review block */}
          {isBulk ? (
            <div className="rounded-lg bg-muted p-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Payouts</span>
                <span className="font-medium">{bulkCount}</span>
              </div>
              {breakdown && breakdown.length > 0 ? (
                breakdown.map((b) => (
                  <div key={b.label} className="mt-2 flex justify-between gap-3">
                    <span
                      className={b.outbound ? undefined : "text-muted-foreground"}
                      style={b.outbound ? { color: "#854F0B" } : undefined}
                    >
                      {b.label} ({b.count})
                    </span>
                    <span className="font-medium" style={b.outbound ? { color: "#854F0B" } : undefined}>
                      {formatRupees(b.amountInPaise)}
                    </span>
                  </div>
                ))
              ) : hasSplit ? (
                <>
                  <div className="mt-2 flex justify-between gap-3">
                    <span className="text-muted-foreground">Commissions (Ref / Clinic / Consult)</span>
                    <span className="font-medium">{formatRupees(commissionsInPaise ?? 0)}</span>
                  </div>
                  <div className="mt-1 flex justify-between gap-3">
                    <span style={{ color: "#854F0B" }}>Outside-lab payables</span>
                    <span className="font-medium" style={{ color: "#854F0B" }}>
                      {formatRupees(labPayablesInPaise ?? 0)}
                    </span>
                  </div>
                </>
              ) : null}
              <div className="mt-2 flex justify-between gap-3 border-t pt-2">
                <span className="text-muted-foreground">Total</span>
                <span className="font-semibold">{formatRupees(bulkTotalInPaise ?? 0)}</span>
              </div>
            </div>
          ) : payout ? (
            <div className="rounded-lg bg-muted p-4 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Payee</span>
                <span className="font-medium text-right">{payout.doctorName}</span>
              </div>
              {payout.periodStartDate && payout.periodEndDate && (
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-muted-foreground">Period</span>
                  <span className="text-right">
                    {fmtPeriod(payout.periodStartDate)} – {fmtPeriod(payout.periodEndDate)}
                  </span>
                </div>
              )}
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold">{formatRupees(payout.derivedAmountInPaise)}</span>
              </div>
              {onViewStatement && (
                <button
                  type="button"
                  onClick={onViewStatement}
                  className="mt-2 text-xs underline"
                  style={{ color: "#2563eb" }}
                >
                  View statement to verify
                </button>
              )}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="pay-method">
              Payment Method <span className="text-destructive">*</span>
            </Label>
            <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v as PaymentType)}>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="pay-ref">Reference ID (Optional)</Label>
              <Input
                id="pay-ref"
                placeholder={paymentMethod === "CHEQUE" ? "Cheque number" : "Transaction ID"}
                value={paymentReferenceId}
                onChange={(e) => setPaymentReferenceId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pay-on">Paid on</Label>
              <Input
                id="pay-on"
                type="date"
                value={paidOn}
                max={todayStr()}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </div>
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

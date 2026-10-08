/**
 * Collect Due — the balance left at billing, collected later, with an optional
 * extra discount (reason required). One dialog for every screen that can see a
 * due: Pending Results, and Patient 360 for any visit — bill-only and finished
 * ones too, which never reach Pending Results.
 *
 * POST /visits/diagnostic/:id/collect-due, sent to the VISIT's branch (Patient
 * 360 shows every branch's visits; the route is branch-scoped).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { API_BASE } from "@/lib/api";
import { apiRequest } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DISCOUNT_REASONS, NOTE_PLACEHOLDER, composeDiscountReason, reasonNeedsNote, type DiscountReason } from "@/lib/discountReasons";

type PaymentType = "CASH" | "ONLINE";
type DiscountMode = "NONE" | "PERCENTAGE" | "FLAT_AMOUNT";

/** The bill being collected on. All money in paise. */
export interface DueBill {
  visitId: string;
  branchId: string;
  totalAmountInPaise: number;
  discountAmountInPaise?: number | null;
  couponDiscountInPaise?: number | null;
  couponCode?: string | null;
  netAmountInPaise?: number | null;
  paidAmountInPaise?: number | null;
  dueAmountInPaise?: number | null;
  /** "CASH" / "ONLINE" / "CASH, ONLINE" — the first one is the default. */
  paymentType?: string | null;
}

/** What the server answers with — the bill's new money fields. */
export interface CollectDueResult {
  paymentType: string;
  paymentBreakdown?: unknown;
  paymentStatus: string;
  discountType?: string | null;
  discountPercentage?: number | null;
  discountAmountInPaise: number;
  discountReason?: string | null;
  couponDiscountInPaise?: number;
  couponCode?: string | null;
  paidAmountInPaise: number;
  netAmountInPaise: number;
  dueAmountInPaise: number;
}

const money = (paise?: number | null) =>
  `₹${((paise ?? 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CollectDueDialog({
  bill,
  onClose,
  onCollected,
}: {
  bill: DueBill | null;
  onClose: () => void;
  onCollected?: (result: CollectDueResult) => void;
}) {
  const [amount, setAmount] = useState("");
  const [paymentType, setPaymentType] = useState<PaymentType>("CASH");
  const [collecting, setCollecting] = useState(false);
  const [done, setDone] = useState(false);
  // Optional discount applied while collecting; the reason is mandatory.
  const [discountMode, setDiscountMode] = useState<DiscountMode>("NONE");
  const [discountValue, setDiscountValue] = useState("");
  const [reasonPick, setReasonPick] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const discountReason = composeDiscountReason(reasonPick, reasonNote);

  // Fresh dialog for each bill: the balance as the amount, its first payment mode.
  useEffect(() => {
    if (!bill) return;
    setAmount(bill.dueAmountInPaise ? String(bill.dueAmountInPaise / 100) : "");
    setPaymentType(bill.paymentType?.split(",")[0]?.trim() === "ONLINE" ? "ONLINE" : "CASH");
    setDiscountMode("NONE");
    setDiscountValue("");
    setReasonPick("");
    setReasonNote("");
    setDone(false);
  }, [bill?.visitId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The extra discount (paise) and its live effect on Discount / Net / Balance.
  const preview = useMemo(() => {
    if (!bill) return null;
    const totalPaise = bill.totalAmountInPaise;
    const netPaise = bill.netAmountInPaise ?? 0;
    const paidPaise = bill.paidAmountInPaise ?? 0;
    const value = Number(discountValue);
    const active = discountMode !== "NONE" && Number.isFinite(value) && value > 0;
    const incrementPaise = !active
      ? 0
      : discountMode === "PERCENTAGE"
        ? Math.round((totalPaise * Math.min(100, value)) / 100)
        : Math.round(value * 100);
    const netPreview = Math.max(0, netPaise - incrementPaise);
    return {
      active,
      discountPaise: Math.min(totalPaise, (bill.discountAmountInPaise ?? 0) + incrementPaise),
      netPreview,
      duePreview: Math.max(0, netPreview - paidPaise),
      // Already paid more than the new net: a refund is needed first.
      tooLarge: incrementPaise > 0 && netPreview < paidPaise,
    };
  }, [bill, discountMode, discountValue]);

  // Keep "Collect now" on the balance after the entered discount.
  const syncAmount = (mode: DiscountMode, raw: string) => {
    if (!bill) return;
    const value = Number(raw);
    const incrementPaise =
      mode !== "NONE" && Number.isFinite(value) && value > 0
        ? mode === "PERCENTAGE"
          ? Math.round((bill.totalAmountInPaise * Math.min(100, value)) / 100)
          : Math.round(value * 100)
        : 0;
    const due = Math.max(0, Math.max(0, (bill.netAmountInPaise ?? 0) - incrementPaise) - (bill.paidAmountInPaise ?? 0));
    setAmount(due > 0 ? String(due / 100) : "0");
  };

  const collect = async () => {
    if (!bill) return;
    const discountActive = discountMode !== "NONE";
    const discountVal = Number(discountValue);
    if (discountActive) {
      if (!Number.isFinite(discountVal) || discountVal <= 0) return void toast.error("Enter a valid discount");
      if (!discountReason.trim()) return void toast.error("A reason is required to apply a discount");
      if (reasonNeedsNote(reasonPick) && !reasonNote.trim()) {
        return void toast.error('Say why in the note — "Other" needs a few words');
      }
      if (preview?.tooLarge) {
        return void toast.error("Discount is larger than the remaining balance — refund the overpaid amount first");
      }
    }
    const value = Number(amount);
    // A discount that clears the whole balance can be applied with no collection.
    const isWaiver = discountActive && (preview?.duePreview ?? 1) === 0;
    if (!isWaiver && (!Number.isFinite(value) || value <= 0)) return void toast.error("Enter a valid collection amount");

    setCollecting(true);
    try {
      const data = await apiRequest<CollectDueResult>(`${API_BASE}/visits/diagnostic/${bill.visitId}/collect-due`, {
        method: "POST",
        headers: { "X-Branch-Id": bill.branchId },
        body: JSON.stringify({
          amount: isWaiver ? 0 : value,
          paymentType,
          ...(discountActive
            ? { discountType: discountMode, discountValue: discountVal, discountReason: discountReason.trim() }
            : {}),
        }),
      });
      onCollected?.(data);
      toast.success(discountActive ? "Discount applied & payment collected" : "Due payment collected");
      setDone(true);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : "Failed to collect due");
    } finally {
      setCollecting(false);
    }
  };

  return (
    <Dialog open={Boolean(bill)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{done ? "Payment Collected" : "Collect Due"}</DialogTitle>
        </DialogHeader>
        {bill && !done && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total</span>
                <span>{money(bill.totalAmountInPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Discount</span>
                <span>-{money(preview?.discountPaise ?? bill.discountAmountInPaise)}</span>
              </div>
              {(bill.couponDiscountInPaise ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Coupon{bill.couponCode ? ` (${bill.couponCode})` : ""}</span>
                  <span>-{money(bill.couponDiscountInPaise)}</span>
                </div>
              )}
              <div className="flex justify-between font-medium">
                <span>Net payable</span>
                <span>{money(preview?.netPreview ?? bill.netAmountInPaise)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Already paid</span>
                <span>{money(bill.paidAmountInPaise)}</span>
              </div>
              <div className="flex justify-between font-semibold text-amber-700">
                <span>Balance due</span>
                <span>{money(preview?.duePreview ?? bill.dueAmountInPaise)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Discount</Label>
              <div className="grid gap-2 sm:grid-cols-[130px_minmax(0,1fr)]">
                <Select
                  value={discountMode}
                  onValueChange={(v) => {
                    const mode = v as DiscountMode;
                    setDiscountMode(mode);
                    setDiscountValue("");
                    setReasonPick("");
                    setReasonNote("");
                    syncAmount(mode, "");
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">No discount</SelectItem>
                    <SelectItem value="PERCENTAGE">Percent %</SelectItem>
                    <SelectItem value="FLAT_AMOUNT">Amount ₹</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="text"
                  inputMode="numeric"
                  value={discountValue}
                  onChange={(e) => {
                    setDiscountValue(e.target.value);
                    syncAmount(discountMode, e.target.value);
                  }}
                  placeholder={discountMode === "PERCENTAGE" ? "Enter discount %" : "Enter discount amount"}
                  disabled={discountMode === "NONE"}
                />
              </div>
              {discountMode !== "NONE" && (
                <div className="grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
                  <Select value={reasonPick} onValueChange={setReasonPick}>
                    <SelectTrigger aria-label="Discount reason">
                      <SelectValue placeholder="Pick a reason (required)" />
                    </SelectTrigger>
                    <SelectContent>
                      {DISCOUNT_REASONS.map((r) => (
                        <SelectItem key={r} value={r}>
                          {r}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label="Discount note"
                    placeholder={reasonPick ? NOTE_PLACEHOLDER[reasonPick as DiscountReason] : "Note (optional)"}
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                  />
                </div>
              )}
              {preview?.tooLarge && (
                <p className="text-xs text-destructive">
                  Discount is larger than the remaining balance. Refund the overpaid amount first.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Collect Now (₹)</Label>
              <Input
                type="number"
                min={0}
                max={(preview?.duePreview ?? bill.dueAmountInPaise ?? 0) / 100}
                step="1"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label>Payment Type</Label>
              <Select value={paymentType} onValueChange={(v) => setPaymentType(v as PaymentType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="ONLINE">Online</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        {bill && done && (
          <div className="space-y-4 py-4 text-center">
            <div className="text-muted-foreground mb-4">Payment recorded successfully. You can now print the updated bill.</div>
            <Button className="w-full" onClick={() => window.open(`/bill/print/DIAGNOSTICS/${bill.visitId}`, "_blank")}>
              Print Updated Bill
            </Button>
          </div>
        )}
        <DialogFooter>
          {!done ? (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={collect} disabled={collecting || !amount}>
                {collecting ? "Collecting..." : "Collect Payment"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

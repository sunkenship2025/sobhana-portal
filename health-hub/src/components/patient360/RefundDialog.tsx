/**
 * RefundDialog — cancel test orders on a diagnostic bill and refund any
 * overpayment (Patient360 inspector action).
 *
 * Flow: pick tests → backend preview (charge voided + money to return, exact
 * discount-aware math) → reason (+ optional note, refund method when money
 * moves) → confirm. The backend voids each order's remaining charge net of its
 * proportional discount share and returns whatever the patient has overpaid as
 * a REFUND ledger row, so due stays exact.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { formatCurrency } from "@/lib/patientDisplay";
import { buildBilledGroups, ungroupedOrders, type BilledGroup } from "@/lib/billedGroups";
import type { VisitTimelineItem } from "@/types";

const REASON_PRESETS = [
  "Patient request",
  "Billing error",
  "Test not performed",
  "Duplicate billing",
  "Other",
] as const;

interface RefundPreview {
  totalReversalInPaise: number;
  refundInPaise: number;
  nextNetAmountInPaise: number;
  nextDueAmountInPaise: number;
  cancelsWholeVisit: boolean;
}

interface RefundResult {
  refundInPaise: number;
  totalReversalInPaise: number;
}

interface RefundDialogProps {
  visit: VisitTimelineItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Order ids to tick on open — the Remove (trash) shortcut in SwapTestDialog. */
  preselectOrderIds?: string[];
}

export function RefundDialog({ visit, open, onOpenChange, preselectOrderIds }: RefundDialogProps) {
  const qc = useQueryClient();
  // Roll leaf orders back up into the products the patient was actually billed
  // for. Listing raw orders would offer to cancel "Hemoglobin ₹23" out of a
  // ₹300 COMPLETE BLOOD PICTURE — leaving a 12-of-13 panel on the bill and a
  // report missing a parameter. Nothing server-side rejects that, so a product
  // has to cancel as one unit here. Same grouping the Replace dialog uses.
  const groups = useMemo<BilledGroup[]>(
    () => buildBilledGroups(visit.testOrders),
    [visit.testOrders],
  );
  // Legacy rows with no productId can't be grouped — offer them individually
  // rather than hide them.
  const looseOrders = useMemo(
    () => ungroupedOrders(visit.testOrders),
    [visit.testOrders],
  );
  const hasBillableItems = groups.length > 0 || looseOrders.length > 0;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState<string>("");
  const [note, setNote] = useState("");
  const [paymentType, setPaymentType] = useState<"CASH" | "ONLINE">("CASH");
  const [preview, setPreview] = useState<RefundPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RefundResult | null>(null);

  // Reset on close / visit switch. Seed the selection from the Remove shortcut
  // when the dialog is opened that way (empty otherwise).
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(preselectOrderIds ?? []));
    setReason("");
    setNote("");
    setPaymentType("CASH");
    setPreview(null);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visit.visitId]);

  // Server-side preview whenever the selection changes (exact math incl.
  // discount allocation lives in the backend — never re-derived here).
  useEffect(() => {
    if (!open || selected.size === 0 || result) {
      setPreview(null);
      return;
    }
    let stale = false;
    setPreviewing(true);
    apiRequest<RefundPreview>(
      `${API_BASE}/visits/diagnostic/${visit.visitId}/refund`,
      {
        method: "POST",
        headers: { "X-Branch-Id": visit.branchId },
        body: JSON.stringify({
          testOrderIds: Array.from(selected),
          preview: true,
        }),
      },
    )
      .then((data) => {
        if (!stale) setPreview(data);
      })
      .catch((err: any) => {
        if (!stale) {
          setPreview(null);
          toast.error(err?.message || "Could not compute refund preview");
        }
      })
      .finally(() => {
        if (!stale) setPreviewing(false);
      });
    return () => {
      stale = true;
    };
  }, [open, selected, visit.visitId, visit.branchId, result]);

  const toggle = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  // A product is only "selected" when every one of its leaf orders is, and
  // toggling moves them together — a partial selection is exactly the broken
  // state this dialog must not be able to produce.
  const isGroupSelected = (group: BilledGroup) =>
    group.orderIds.every((orderId) => selected.has(orderId));

  const toggleGroup = (group: BilledGroup) => {
    const allSelected = isGroupSelected(group);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const orderId of group.orderIds) {
        if (allSelected) next.delete(orderId);
        else next.add(orderId);
      }
      return next;
    });
  };

  const submit = async () => {
    if (selected.size === 0 || !reason) return;
    setBusy(true);
    try {
      const data = await apiRequest<RefundResult>(
        `${API_BASE}/visits/diagnostic/${visit.visitId}/refund`,
        {
          method: "POST",
          headers: { "X-Branch-Id": visit.branchId },
          body: JSON.stringify({
            testOrderIds: Array.from(selected),
            reason,
            note: note.trim() || undefined,
            paymentType,
          }),
        },
      );
      setResult(data);
      // Timeline + summary both change (due, chips, outstanding rollup).
      qc.invalidateQueries({ queryKey: ["patient360"] });
      toast.success(
        data.refundInPaise > 0
          ? `Cancelled — refund ${formatCurrency(data.refundInPaise)} to the patient`
          : "Selected tests cancelled",
      );
    } catch (err: any) {
      toast.error(err?.message || "Failed to process cancellation");
    } finally {
      setBusy(false);
    }
  };

  const refundInPaise = preview?.refundInPaise ?? 0;

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{result ? "Cancellation processed" : "Cancel / Refund tests"}</DialogTitle>
          {!result && (
            <DialogDescription>
              Bill {visit.billNumber || visit.visitRef} — select the tests to cancel.
            </DialogDescription>
          )}
        </DialogHeader>

        {!result && (
          <div className="space-y-4">
            <div className="max-h-[38vh] space-y-1 overflow-y-auto rounded-lg border p-2">
              {!hasBillableItems && (
                <p className="p-2 text-sm text-muted-foreground">
                  No active tests left on this bill.
                </p>
              )}
              {groups.map((group) => (
                <label
                  key={group.productId}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                >
                  <span className="flex items-center gap-2">
                    <Checkbox
                      checked={isGroupSelected(group)}
                      onCheckedChange={() => toggleGroup(group)}
                    />
                    {group.name}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(group.totalInPaise)}
                  </span>
                </label>
              ))}
              {looseOrders.map((order) => (
                <label
                  key={order.id}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                >
                  <span className="flex items-center gap-2">
                    <Checkbox
                      checked={selected.has(order.id)}
                      onCheckedChange={() => toggle(order.id)}
                    />
                    {order.testName}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatCurrency(order.priceInPaise)}
                  </span>
                </label>
              ))}
            </div>

            {selected.size > 0 && (
              <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Charge to cancel</span>
                  <span>
                    {previewing ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      `− ${formatCurrency(preview?.totalReversalInPaise ?? 0)}`
                    )}
                  </span>
                </div>
                <div className="flex justify-between font-medium">
                  <span className="text-muted-foreground">Money to return</span>
                  <span>{previewing ? "…" : formatCurrency(refundInPaise)}</span>
                </div>
                {preview && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Remaining due after</span>
                    <span>{formatCurrency(preview.nextDueAmountInPaise)}</span>
                  </div>
                )}
                {preview?.cancelsWholeVisit && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    This cancels every test — the whole visit will be marked cancelled.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label>Reason</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASON_PRESETS.map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {preset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Note (optional)</Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Extra detail for the record"
              />
            </div>

            {refundInPaise > 0 && (
              <div className="space-y-2">
                <Label>Refund method</Label>
                <Select
                  value={paymentType}
                  onValueChange={(v) => setPaymentType(v as "CASH" | "ONLINE")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CASH">Cash</SelectItem>
                    <SelectItem value="ONLINE">Online</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {result && (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Charge cancelled</span>
              <span>− {formatCurrency(result.totalReversalInPaise)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span className="text-muted-foreground">Returned to patient</span>
              <span>{formatCurrency(result.refundInPaise)}</span>
            </div>
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                Back
              </Button>
              <Button
                variant="destructive"
                disabled={busy || previewing || selected.size === 0 || !reason}
                onClick={submit}
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                {refundInPaise > 0
                  ? `Cancel & refund ${formatCurrency(refundInPaise)}`
                  : "Cancel tests"}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

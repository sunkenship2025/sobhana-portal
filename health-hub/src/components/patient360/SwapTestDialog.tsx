/**
 * SwapTestDialog — the "Billed tests" pencil in the inspector. Two modes on the
 * same billed-tests surface (no separate dialog):
 *
 *  - Replace: swap a mistakenly billed test/panel for another of the SAME price
 *    (typo fixes like SERUM CREATININE → URIC ACID). Money-neutral by
 *    construction: the backend rejects any price mismatch, demands a reason,
 *    audit-logs old → new, and refuses finalized reports / outsourced tests.
 *  - Add: add one or more billable products to a not-yet-finalized visit at
 *    catalog price; the delta raises the bill and becomes Due. Gated to
 *    owner / lab incharge (bills > 7 days old are owner-only) — the server
 *    enforces it (addProductsToVisit); the UI just hides the option when the
 *    signed-in staff can't use it, and every add is flagged HIGH in the owner
 *    ops feed.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { formatCurrency } from "@/lib/patientDisplay";
import { useAuthStore } from "@/store/authStore";
import type { VisitTimelineItem } from "@/types";

const REASON_PRESETS = [
  "Wrong test selected at billing",
  "Doctor changed the instruction",
  "Typing mistake",
  "Other",
] as const;

// Mirrors the server gate in addProductsToVisit. Front-desk `staff`/`sales` are
// excluded; bills older than a week are owner-only.
const ADD_TESTS_ROLES = new Set(["owner", "admin", "lab_incharge"]);
const ADD_TESTS_OWNER_TIER = new Set(["owner", "admin"]);
const ADD_TESTS_SELF_SERVE_DAYS = 7;

interface ProductLite {
  id: string;
  name: string;
  code?: string;
  basePriceInPaise?: number;
  workflowMode?: string;
}

// Small colored tag so staff can tell a reportable test from a bill-only /
// external-upload one at a glance (same palette as Manage Billable Products).
const WORKFLOW_TAG: Record<string, { label: string; className: string }> = {
  REPORTABLE: { label: "Reportable", className: "bg-emerald-100 text-emerald-800" },
  BILL_ONLY: { label: "Bill Only", className: "bg-amber-100 text-amber-800" },
  EXTERNAL_UPLOAD: { label: "External", className: "bg-sky-100 text-sky-800" },
  EVENT: { label: "Event", className: "bg-red-100 text-red-800" },
};

interface BilledGroup {
  productId: string;
  name: string;
  totalInPaise: number;
  isOutsourced: boolean;
}

interface SwapTestDialogProps {
  visit: VisitTimelineItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SwapTestDialog({ visit, open, onOpenChange }: SwapTestDialogProps) {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const role = user?.role;

  // Add-tests availability (server still enforces). Only owner/admin/lab_incharge,
  // never a finalized report, and bills > 7 days old are owner-only.
  const isFinalized =
    visit.reportStatus === "FINALIZED" || Boolean(visit.finalizedAt);
  const billAgeDays = Math.floor(
    (Date.now() - new Date(visit.billedAt ?? visit.createdAt).getTime()) /
      86_400_000,
  );
  const canAddTests =
    !!role &&
    ADD_TESTS_ROLES.has(role) &&
    !isFinalized &&
    (billAgeDays <= ADD_TESTS_SELF_SERVE_DAYS || ADD_TESTS_OWNER_TIER.has(role));

  const [mode, setMode] = useState<"replace" | "add">("replace");

  // Active billed items grouped by product (a panel's constituent orders roll
  // up into one line, matching what the printed bill shows).
  const groups = useMemo<BilledGroup[]>(() => {
    const map = new Map<string, BilledGroup>();
    for (const order of visit.testOrders ?? []) {
      if (order.cancelledAt || !order.productId) continue;
      const existing = map.get(order.productId);
      if (existing) {
        existing.totalInPaise += order.priceInPaise;
        existing.isOutsourced = existing.isOutsourced || Boolean(order.isOutsourced);
      } else {
        map.set(order.productId, {
          productId: order.productId,
          name: order.productName || order.testName,
          totalInPaise: order.priceInPaise,
          isOutsourced: Boolean(order.isOutsourced),
        });
      }
    }
    return Array.from(map.values());
  }, [visit.testOrders]);

  const [oldProductId, setOldProductId] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [newProductId, setNewProductId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  // Add mode: multi-select of products to add.
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setMode("replace");
    setOldProductId(groups.length === 1 ? groups[0].productId : null);
    setQuery("");
    setNewProductId(null);
    setReason("");
    setNote("");
    setAddSelected(new Set());
    setLoading(true);
    apiRequest<ProductLite[]>(`${API_BASE}/billable-products`, {
      headers: { "X-Branch-Id": visit.branchId },
    })
      .then((list) => setProducts(Array.isArray(list) ? list : []))
      .catch(() => toast.error("Could not load the test catalogue"))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visit.visitId]);

  const selectedGroup = groups.find((group) => group.productId === oldProductId);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter(
        (product) =>
          product.id !== oldProductId &&
          (!q ||
            product.name.toLowerCase().includes(q) ||
            (product.code || "").toLowerCase().includes(q)),
      )
      // Cap high enough to reach the whole catalogue by scrolling; the search
      // box narrows it further. (Was 30 — too low to see every test.)
      .slice(0, 300);
  }, [products, query, oldProductId]);

  // Products already active on the visit — excluded from the add picker so a
  // duplicate can't be added (the server rejects it too).
  const existingProductIds = useMemo(
    () =>
      new Set(
        (visit.testOrders ?? [])
          .filter((order) => !order.cancelledAt)
          .map((order) => order.productId)
          .filter((id): id is string => Boolean(id)),
      ),
    [visit.testOrders],
  );
  const addFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products
      .filter(
        (product) =>
          !existingProductIds.has(product.id) &&
          (!q ||
            product.name.toLowerCase().includes(q) ||
            (product.code || "").toLowerCase().includes(q)),
      )
      .slice(0, 300);
  }, [products, query, existingProductIds]);
  const addTotalInPaise = useMemo(
    () =>
      products
        .filter((product) => addSelected.has(product.id))
        .reduce((sum, product) => sum + (product.basePriceInPaise ?? 0), 0),
    [products, addSelected],
  );

  const submit = async () => {
    if (!oldProductId || !newProductId || !reason) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ newProductName: string }>(
        `${API_BASE}/visits/diagnostic/${visit.visitId}/swap-product`,
        {
          method: "POST",
          headers: { "X-Branch-Id": visit.branchId },
          body: JSON.stringify({
            oldProductId,
            newProductId,
            reason,
            note: note.trim() || undefined,
          }),
        },
      );
      qc.invalidateQueries({ queryKey: ["patient360"] });
      toast.success(`Replaced with ${result.newProductName}`);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to swap the test");
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = async () => {
    const ids = Array.from(addSelected);
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ addedProductNames?: string[] }>(
        `${API_BASE}/visits/diagnostic/${visit.visitId}/tests`,
        {
          method: "POST",
          headers: { "X-Branch-Id": visit.branchId },
          body: JSON.stringify({ productIds: ids }),
        },
      );
      qc.invalidateQueries({ queryKey: ["patient360"] });
      const n = result.addedProductNames?.length ?? ids.length;
      toast.success(`Added ${n} test${n === 1 ? "" : "s"}`);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to add tests");
    } finally {
      setBusy(false);
    }
  };

  const toggleAdd = (id: string) => {
    setAddSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (!busy ? onOpenChange(o) : undefined)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{canAddTests ? "Edit billed tests" : "Replace a billed test"}</DialogTitle>
          <DialogDescription>
            Bill {visit.billNumber || visit.visitRef}
            {mode === "replace"
              ? " — same-price replacement only; use Cancel / Refund for price changes."
              : " — added tests are charged at catalogue price and become Due."}
          </DialogDescription>
        </DialogHeader>

        {canAddTests && (
          <div className="flex gap-1 rounded-lg border p-1">
            <Button
              type="button"
              size="sm"
              variant={mode === "replace" ? "secondary" : "ghost"}
              className="flex-1"
              disabled={busy}
              onClick={() => setMode("replace")}
            >
              Replace
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "add" ? "secondary" : "ghost"}
              className="flex-1"
              disabled={busy}
              onClick={() => setMode("add")}
            >
              Add tests
            </Button>
          </div>
        )}

        <div className="-mr-2 min-h-0 flex-1 space-y-4 overflow-y-auto pr-2">
          {mode === "replace" ? (
            <>
              <div className="space-y-2">
                <Label>Billed test to replace</Label>
                <div className="max-h-[22vh] space-y-0.5 overflow-y-auto rounded-lg border p-1">
                  {groups.map((group) => (
                    <button
                      key={group.productId}
                      type="button"
                      disabled={group.isOutsourced}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50 ${oldProductId === group.productId ? "bg-muted font-medium" : ""}`}
                      onClick={() => setOldProductId(group.productId)}
                    >
                      <span>
                        {group.name}
                        {group.isOutsourced && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            outsourced — use cancel/refund
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatCurrency(group.totalInPaise)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {selectedGroup && (
                <div className="space-y-2">
                  <Label className="flex items-center gap-1.5">
                    Replace with
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="font-normal text-muted-foreground">
                      must be {formatCurrency(selectedGroup.totalInPaise)}
                    </span>
                  </Label>
                  <Input
                    placeholder="Search tests…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="max-h-[32vh] space-y-0.5 overflow-y-auto rounded-lg border p-1">
                    {loading && (
                      <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                      </div>
                    )}
                    {filtered.map((product) => {
                      const tag = product.workflowMode
                        ? WORKFLOW_TAG[product.workflowMode]
                        : undefined;
                      return (
                        <button
                          key={product.id}
                          type="button"
                          className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${newProductId === product.id ? "bg-muted font-medium" : ""}`}
                          onClick={() => setNewProductId(product.id)}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{product.name}</span>
                            {tag && (
                              <Badge className={`${tag.className} shrink-0 text-[10px] px-1.5`}>
                                {tag.label}
                              </Badge>
                            )}
                            {newProductId === product.id && (
                              <Check className="h-3.5 w-3.5 shrink-0" />
                            )}
                          </span>
                          {typeof product.basePriceInPaise === "number" && (
                            <span className="tabular-nums text-muted-foreground shrink-0">
                              {formatCurrency(product.basePriceInPaise)}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
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
            </>
          ) : (
            <div className="space-y-2">
              <Label className="flex items-center justify-between gap-2">
                <span>Tests to add</span>
                {addSelected.size > 0 && (
                  <span className="font-normal tabular-nums text-muted-foreground">
                    {addSelected.size} selected · +{formatCurrency(addTotalInPaise)}
                  </span>
                )}
              </Label>
              <Input
                placeholder="Search tests…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="max-h-[46vh] space-y-0.5 overflow-y-auto rounded-lg border p-1">
                {loading && (
                  <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                  </div>
                )}
                {addFiltered.map((product) => {
                  const tag = product.workflowMode
                    ? WORKFLOW_TAG[product.workflowMode]
                    : undefined;
                  const selected = addSelected.has(product.id);
                  return (
                    <button
                      key={product.id}
                      type="button"
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60 ${selected ? "bg-muted font-medium" : ""}`}
                      onClick={() => toggleAdd(product.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{product.name}</span>
                        {tag && (
                          <Badge className={`${tag.className} shrink-0 text-[10px] px-1.5`}>
                            {tag.label}
                          </Badge>
                        )}
                        {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </span>
                      {typeof product.basePriceInPaise === "number" && (
                        <span className="tabular-nums text-muted-foreground shrink-0">
                          {formatCurrency(product.basePriceInPaise)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Back
          </Button>
          {mode === "replace" ? (
            <Button
              disabled={busy || !oldProductId || !newProductId || !reason}
              onClick={submit}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Replace test
            </Button>
          ) : (
            <Button disabled={busy || addSelected.size === 0} onClick={submitAdd}>
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {addSelected.size > 0
                ? `Add ${addSelected.size} test${addSelected.size === 1 ? "" : "s"}`
                : "Add tests"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

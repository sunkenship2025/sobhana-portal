/**
 * NoReportStatus — inspector trace for tests closed as "no written report
 * needed" (films only; patient declined the narrative report). Without this the
 * Report section just goes blank, so a returning patient's "where's my report?"
 * has no answer on screen.
 *
 * Renders one muted line per such order — the DeliveryStatusLine idiom (icon +
 * text, never color-only) — carrying who / when / why. Offers a quiet Reopen per
 * order while the visit's report isn't finalized (mirrors the backend guard:
 * reopen is refused once any FINALIZED version exists → reportState is
 * FINALIZED / PARTIALLY_FINALIZED here). Hidden entirely when no order is closed
 * this way.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/use-confirm";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import type { VisitTimelineItem } from "@/types";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
}

interface NoReportStatusProps {
  visit: VisitTimelineItem;
}

export function NoReportStatus({ visit }: NoReportStatusProps) {
  const qc = useQueryClient();
  const { confirm, ConfirmDialog } = useConfirm();
  const [busyId, setBusyId] = useState<string | null>(null);

  const orders = visit.testOrders ?? [];
  const noReportOrders = orders.filter(
    (order) => !!order.noReportAt && !order.cancelledAt,
  );
  if (noReportOrders.length === 0) return null;

  // Name the test only when it's ambiguous (more than one live test on the
  // visit); a single-test visit reads cleaner without it.
  const showTestName = orders.filter((o) => !o.cancelledAt).length > 1;

  // The report is done → the close can no longer be undone (backend refuses it).
  const kind = visit.reportState?.kind;
  const canReopen = kind !== "FINALIZED" && kind !== "PARTIALLY_FINALIZED";

  const reopen = async (orderId: string, testName: string) => {
    const ok = await confirm({
      title: "Reopen this test?",
      description: `Moves ${testName} back to Enter Results so a report can be produced. The bill is unchanged.`,
      confirmText: "Reopen",
    });
    if (!ok) return;
    setBusyId(orderId);
    try {
      await apiRequest(
        `${API_BASE}/visits/diagnostic/${visit.visitId}/orders/${orderId}/reopen-report`,
        { method: "POST", headers: { "X-Branch-Id": visit.branchId } },
      );
      qc.invalidateQueries({ queryKey: ["patient360"] });
      toast.success("Reopened — now in Enter Results");
    } catch (err: any) {
      toast.error(err?.message || "Failed to reopen test");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-2">
      {noReportOrders.map((order) => {
        const parts = ["No report needed"];
        if (showTestName) parts.push(order.testName);
        if (order.noReportAt) parts.push(formatDate(order.noReportAt));
        if (order.noReportBy) parts.push(order.noReportBy);
        return (
          <div key={order.id} className="space-y-0.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <FileX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{parts.join(" · ")}</span>
              {canReopen && (
                <Button
                  variant="link"
                  className="ml-auto h-auto p-0 text-xs font-medium"
                  disabled={busyId === order.id}
                  onClick={() => reopen(order.id, order.testName)}
                >
                  {busyId === order.id ? "Reopening…" : "Reopen"}
                </Button>
              )}
            </div>
            {order.noReportReason && (
              <p className="pl-5 text-xs text-muted-foreground">
                {order.noReportReason}
              </p>
            )}
          </div>
        );
      })}
      {ConfirmDialog}
    </div>
  );
}

/**
 * useReportActions — single source of truth for the report View/Print/WhatsApp
 * actions in Patient360 (06-frontend-plan.md §3.3). Fixes three constraint bugs
 * at once:
 *
 *  1. Per-visit busy state — clicking visit A's report never disables visit B's
 *     button (replaces the old shared `previewLoading` boolean).
 *  2. Single WhatsApp path — `sendWhatsApp(visitId)` is the ONE place the
 *     send-report POST lives; both legacy call sites delete their duplicates.
 *  3. Blob lifecycle — `urlRef` owns the preview blob URL: revoked on preview
 *     change, on closePreview, and on unmount. The report endpoints ARE
 *     branch-scoped, so the PDF fetch + send-report carry X-Branch-Id.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fetchFinalizedReportPdfBlobUrl,
  openFinalizedReportWindow,
} from "@/lib/reportAccess";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";

export type ReportAction = "view" | "print" | "whatsapp";

export interface ReportBusy {
  visitId: string;
  action: ReportAction;
}

export interface ReportPreview {
  visitId: string;
  /** 'report' = finalized-report blob PDF; 'bill' = the /bill/print app route. */
  kind: "report" | "bill";
  /** Blob URL — only set when kind === 'report'. */
  reportUrl?: string;
}

export interface UseReportActions {
  /** Currently in-flight action, or null. Per-visit so siblings stay enabled. */
  busy: ReportBusy | null;
  /** True if the given visit (optionally a specific action) is in flight. */
  isBusy: (visitId: string, action?: ReportAction) => boolean;
  /** The open inline preview or null. */
  preview: ReportPreview | null;
  /** Toggle the inline report preview: fetch + open, or collapse if already open. */
  viewReport: (visitId: string) => Promise<void>;
  /** Toggle the inline bill preview (embeds the /bill/print route). */
  viewBill: (visitId: string) => void;
  /** Open the finalized report in a new tab and auto-print. */
  printReport: (visitId: string) => Promise<void>;
  /** POST /messages/:visitId/send-report (branch-scoped). The ONE WhatsApp path. */
  sendWhatsApp: (visitId: string) => Promise<void>;
  /** Revoke the current preview blob and clear `preview`. */
  closePreview: () => void;
}

export function useReportActions(isMobile?: boolean): UseReportActions {
  const token = useAuthStore((s) => s.token);
  const branchId = useBranchStore((s) => s.activeBranchId);

  const [busy, setBusy] = useState<ReportBusy | null>(null);
  const [preview, setPreview] = useState<ReportPreview | null>(null);

  // urlRef owns the live blob URL independently of React state so the cleanup
  // paths (unmount, isMobile swap) can revoke without a stale-closure read.
  const urlRef = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const closePreview = useCallback(() => {
    revoke();
    setPreview(null);
  }, [revoke]);

  const isBusy = useCallback(
    (visitId: string, action?: ReportAction) =>
      busy?.visitId === visitId && (action === undefined || busy.action === action),
    [busy],
  );

  // Toggle: if the report preview for this visit is already open, collapse it;
  // otherwise fetch the PDF and open it inline.
  const viewReport = useCallback(
    async (visitId: string) => {
      if (preview?.visitId === visitId && preview.kind === "report") {
        closePreview();
        return;
      }
      setBusy({ visitId, action: "view" });
      try {
        const url = await fetchFinalizedReportPdfBlobUrl({
          visitId,
          token,
          branchId,
          mode: "digital",
        });
        revoke(); // drop any prior preview blob before swapping in the new one
        urlRef.current = url;
        setPreview({ visitId, kind: "report", reportUrl: url });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load report.");
      } finally {
        setBusy(null);
      }
    },
    [preview, token, branchId, revoke, closePreview],
  );

  // Toggle the inline bill preview (embeds the same-origin /bill/print route).
  // No fetch/blob — the inspector builds the iframe src from the visit.
  const viewBill = useCallback(
    (visitId: string) => {
      if (preview?.visitId === visitId && preview.kind === "bill") {
        closePreview();
        return;
      }
      revoke(); // switching away from a report preview frees its blob
      setPreview({ visitId, kind: "bill" });
    },
    [preview, revoke, closePreview],
  );

  const printReport = useCallback(
    async (visitId: string) => {
      setBusy({ visitId, action: "print" });
      try {
        await openFinalizedReportWindow({ visitId, token, branchId, autoPrint: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to print report.");
      } finally {
        setBusy(null);
      }
    },
    [token, branchId],
  );

  const sendWhatsApp = useCallback(
    async (visitId: string) => {
      setBusy({ visitId, action: "whatsapp" });
      try {
        // Report endpoints ARE branch-scoped → carry X-Branch-Id explicitly.
        await apiRequest(`${API_BASE}/messages/${visitId}/send-report`, {
          method: "POST",
          headers: { "X-Branch-Id": branchId ?? "" },
        });
        toast.success("Report sent on WhatsApp.");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send report.");
      } finally {
        setBusy(null);
      }
    },
    [branchId],
  );

  // Revoke on unmount.
  useEffect(() => revoke, [revoke]);

  // Revoke on the desktop↔mobile swap: the swap unmounts the inspector but this
  // hook instance lives in the page and survives, orphaning the blob otherwise.
  useEffect(() => {
    closePreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  return {
    busy,
    isBusy,
    preview,
    viewReport,
    viewBill,
    printReport,
    sendWhatsApp,
    closePreview,
  };
}

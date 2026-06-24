/**
 * DeliveryStatusLine — progressive Sent → Delivered → Read (or Failed) line
 * derived from `item.delivery` (§6). NOT a chip: an inspector-only inline
 * progression. Hidden entirely when `delivery` is null. Shows the
 * furthest-reached step (icon + text, never color-only — §8).
 */
import { Check, CheckCheck, Clock, Send, XCircle } from "lucide-react";
import type { VisitDelivery } from "@/types";

function formatDateTime(date: Date | string | null): string {
  if (!date) return "";
  return new Date(date).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface DeliveryStatusLineProps {
  delivery: VisitDelivery | null;
}

export function DeliveryStatusLine({ delivery }: DeliveryStatusLineProps) {
  if (!delivery) return null;

  const status = (delivery.status || "").toUpperCase();

  // Furthest-reached step wins. Order: FAILED → READ → DELIVERED → SENT → queued.
  if (status === "FAILED") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-destructive">
        <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Delivery failed</span>
      </p>
    );
  }

  if (status === "READ" || delivery.readAt) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-blue-600">
        <CheckCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Read{delivery.readAt ? ` · ${formatDateTime(delivery.readAt)}` : ""}</span>
      </p>
    );
  }

  if (status === "DELIVERED" || delivery.deliveredAt) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Delivered{delivery.deliveredAt ? ` · ${formatDateTime(delivery.deliveredAt)}` : ""}
        </span>
      </p>
    );
  }

  if (status === "SENT" || delivery.sentAt) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Sent{delivery.sentAt ? ` · ${formatDateTime(delivery.sentAt)}` : ""}</span>
      </p>
    );
  }

  // PENDING / unknown → queued.
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === "PENDING" ? (
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Send className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <span>Queued</span>
    </p>
  );
}

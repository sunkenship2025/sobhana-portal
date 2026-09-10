/**
 * DeliveryStatusLine — progressive Sent → Delivered → Read (or Failed) line
 * derived from `item.delivery` (§6). NOT a chip: an inspector-only inline
 * progression. Hidden entirely when `delivery` is null.
 *
 * The furthest-reached step is the visible line (icon + text, never
 * color-only — §8); the steps it passed through unfold under it on click,
 * newest first, so the trail reads Read → Delivered → Sent. Collapsed by
 * default: the answer most people want is "did they open it", and the send
 * time is one click away when they want the lag.
 */
import { Check, CheckCheck, ChevronRight, Clock, Send, XCircle } from "lucide-react";
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

type Step = {
  key: string;
  Icon: typeof Check;
  label: string;
  at: Date | string | null;
  tone: string;
};

export function DeliveryStatusLine({ delivery }: DeliveryStatusLineProps) {
  if (!delivery) return null;

  const status = (delivery.status || "").toUpperCase();

  if (status === "FAILED") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-destructive">
        <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Delivery failed</span>
      </p>
    );
  }

  // Newest first. A step counts as reached if it carries a timestamp, or if
  // it IS the current status — a webhook can move the status to READ without
  // every earlier stamp having landed.
  const steps: Step[] = (
    [
      { key: "READ", Icon: CheckCheck, label: "Read", at: delivery.readAt, tone: "text-blue-600" },
      {
        key: "DELIVERED",
        Icon: CheckCheck,
        label: "Delivered",
        at: delivery.deliveredAt,
        tone: "text-muted-foreground",
      },
      { key: "SENT", Icon: Check, label: "Sent", at: delivery.sentAt, tone: "text-muted-foreground" },
    ] as Step[]
  ).filter((s) => s.at || status === s.key);

  // PENDING / unknown → queued.
  if (steps.length === 0) {
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

  const [head, ...rest] = steps;
  const body = ({ Icon, label, at }: Step) => (
    <>
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {label}
        {at ? ` · ${formatDateTime(at)}` : ""}
      </span>
    </>
  );

  // Nothing earlier to reveal → the plain line, no caret to click on nothing.
  if (rest.length === 0) {
    return <p className={`flex items-center gap-1.5 text-xs ${head.tone}`}>{body(head)}</p>;
  }

  return (
    <details className="group">
      <summary
        className={`flex cursor-pointer list-none items-center gap-1.5 text-xs ${head.tone} [&::-webkit-details-marker]:hidden`}
      >
        <ChevronRight
          className="h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        {body(head)}
      </summary>
      <div className="mt-1 flex flex-col gap-1 pl-[18px]">
        {rest.map((s) => (
          <p key={s.key} className={`flex items-center gap-1.5 text-xs ${s.tone}`}>
            {body(s)}
          </p>
        ))}
      </div>
    </details>
  );
}

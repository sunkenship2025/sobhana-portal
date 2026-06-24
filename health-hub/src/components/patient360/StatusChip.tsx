/**
 * StatusChip — Patient360 status chip (§6, §8).
 *
 * A FRESH CVA component (it does NOT extend StatusBadge). Renders icon + visible
 * text so meaning is never color-only (WCAG SC 1.4.1). Reuses the existing
 * `status-paid/pending/draft/finalized` CSS classes (src/index.css).
 *
 * `mapReportStateToChip` is the SINGLE place the ReportState discriminated union
 * is decoded into a renderable chip — no other component branches on `kind`.
 *
 * Kinds: payment | report | abnormal | cancelled.
 */
import { cva, type VariantProps } from "class-variance-authority";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  RotateCcw,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/patientDisplay";
import type {
  ReportState,
  VisitPaymentStatus,
} from "@/types";

const chipVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        paid: "status-paid",
        pending: "status-pending",
        draft: "status-draft",
        finalized: "status-finalized",
        abnormal:
          "bg-destructive/15 text-destructive",
        muted: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      tone: "muted",
    },
  },
);

type ChipTone = NonNullable<VariantProps<typeof chipVariants>["tone"]>;

export interface ChipDescriptor {
  label: string;
  icon: LucideIcon | null;
  tone: ChipTone;
  /** Renders as role="status" for the abnormal flag (announced to AT). */
  role?: "status";
}

export type ChipKind = "payment" | "report" | "abnormal" | "cancelled";

interface StatusChipProps {
  kind: ChipKind;
  value?: VisitPaymentStatus | ReportState | boolean | null;
  /** Required by `payment` kind to render "Due ₹…"; ignored otherwise. */
  dueAmountInPaise?: number;
  /** Required by `payment` kind to detect partial payment; ignored otherwise. */
  paidAmountInPaise?: number;
  className?: string;
}

// --- decoders (the only places each union is read) -------------------------

/**
 * Decode a ReportState into a chip descriptor. Returns null for `null` state or
 * CLINIC (caller renders nothing). Single source of truth for the report chip.
 */
export function mapReportStateToChip(
  state: ReportState | undefined,
): ChipDescriptor | null {
  if (!state) return null;
  switch (state.kind) {
    case "FINALIZED":
      return {
        label: `Finalized v${state.version}`,
        icon: CheckCircle2,
        tone: "finalized",
      };
    case "PARTIALLY_FINALIZED":
      return {
        label: `Partial · ${state.finalized} of ${state.total}`,
        icon: Loader2,
        tone: "pending",
      };
    case "BILL_ONLY":
      return { label: "Bill only", icon: FileText, tone: "draft" };
    case "EXTERNAL_UPLOAD_PENDING":
      return { label: "Awaiting upload", icon: Upload, tone: "pending" };
    case "RESULTS_PENDING":
      return { label: "Results pending", icon: Clock, tone: "pending" };
    default:
      return null;
  }
}

function mapPaymentToChip(
  value: VisitPaymentStatus | null | undefined,
  dueAmountInPaise: number | undefined,
  paidAmountInPaise: number | undefined,
): ChipDescriptor | null {
  const due = dueAmountInPaise ?? 0;
  const paid = paidAmountInPaise ?? 0;

  if (value === "REFUNDED") {
    return { label: "Refunded", icon: RotateCcw, tone: "draft" };
  }
  if (value === "PAID") {
    return { label: "Paid", icon: CheckCircle2, tone: "paid" };
  }
  // PENDING / FAILED / null with a positive due
  if (due > 0) {
    const isPartial = paid > 0;
    return {
      label: isPartial
        ? `Partial · Due ${formatCurrency(due)}`
        : `Due ${formatCurrency(due)}`,
      icon: AlertCircle,
      tone: "pending",
    };
  }
  if (value === "PENDING") {
    return { label: "Pending", icon: Clock, tone: "pending" };
  }
  // no bill / nothing due
  return null;
}

function describe(props: StatusChipProps): ChipDescriptor | null {
  switch (props.kind) {
    case "payment":
      return mapPaymentToChip(
        (props.value as VisitPaymentStatus | null | undefined) ?? null,
        props.dueAmountInPaise,
        props.paidAmountInPaise,
      );
    case "report":
      return mapReportStateToChip(props.value as ReportState | undefined);
    case "abnormal":
      return props.value === true
        ? {
            label: "Abnormal results",
            icon: AlertTriangle,
            tone: "abnormal",
            role: "status",
          }
        : null;
    case "cancelled":
      return { label: "Cancelled", icon: Ban, tone: "muted" };
    default:
      return null;
  }
}

export function StatusChip(props: StatusChipProps) {
  const descriptor = describe(props);
  if (!descriptor) return null;

  const Icon = descriptor.icon;
  return (
    <span
      className={cn(chipVariants({ tone: descriptor.tone }), props.className)}
      role={descriptor.role}
    >
      {Icon ? <Icon className="h-3 w-3 shrink-0" aria-hidden="true" /> : null}
      <span>{descriptor.label}</span>
    </span>
  );
}

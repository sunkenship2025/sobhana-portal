/**
 * SmartReportStatusLine — inline state for the visit's Smart Report, in the same
 * inspector-only style as DeliveryStatusLine. Icon + text, never colour alone.
 *
 * The state that justifies this component is TEMPLATE. Generation is
 * fire-and-forget at finalize, so when the model errors or the validator rejects
 * its prose, the report still ships: every number is right and the page renders
 * identically, the patient just gets mechanical wording instead of the
 * plain-language summary the product is for. Nothing looks broken, so without a
 * line here the first person to notice is the patient.
 */
import { AlertTriangle, CheckCircle2, Clock, EyeOff, FileText, MinusCircle } from "lucide-react";

export interface SmartReportState {
  status: "PENDING" | "READY" | "FAILED" | "SKIPPED";
  usedFallbackCopy: boolean;
  sendSuppressed: boolean;
  score: number | null;
  skipReason: string | null;
}

/** Skip reasons are enum-ish strings; only show ones staff can act on. */
const SKIP_TEXT: Record<string, string> = {
  NO_SMART_REPORT_PRODUCT: "package is not enabled for Smart Reports",
  PACKAGE_NO_LONGER_ELIGIBLE: "package is no longer eligible",
  NO_ANALYSABLE_TESTS: "no tests with reference ranges",
  BELOW_MIN_PARAMETERS: "too few scored parameters",
  PATIENT_BELOW_MIN_AGE: "patient is below the minimum age",
  DISABLED: "Smart Reports are switched off",
  LINK_DISABLED: "the patient link is disabled",
};

export function SmartReportStatusLine({ smart }: { smart: SmartReportState | null }) {
  if (!smart) return null;

  if (smart.sendSuppressed) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <EyeOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Smart Report withdrawn — resends use the plain report message</span>
      </p>
    );
  }

  if (smart.status === "FAILED") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Smart Report failed — the patient did not get one</span>
      </p>
    );
  }

  if (smart.status === "PENDING") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Smart Report is being prepared</span>
      </p>
    );
  }

  if (smart.status === "SKIPPED") {
    const why = smart.skipReason ? SKIP_TEXT[smart.skipReason] : null;
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MinusCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>No Smart Report{why ? ` — ${why}` : ""}</span>
      </p>
    );
  }

  // READY, but the wording is the mechanical fallback rather than the model's.
  if (smart.usedFallbackCopy) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-amber-700">
        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Smart Report sent with standard wording{smart.score !== null ? ` · ${smart.score}/100` : ""}
          {" "}— the written summary could not be prepared
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>Smart Report ready{smart.score !== null ? ` · ${smart.score}/100` : ""}</span>
    </p>
  );
}

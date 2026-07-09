/**
 * SmartSearchResults — routes the smart-search UI on effectiveKind + state.
 *
 * Inputs are the resolved state from useSmartSearch (patient paths) and
 * useBillLookup (bill path). The host (GlobalPatientSearch) owns both hooks and
 * passes the relevant slice down. States (§6):
 *   idle (empty input)        → RecentlyViewed
 *   below-min / not-yet-fired → nothing (badge-only feedback lives in the bar)
 *   loading                   → skeleton rows / LoadingState
 *   patient []                → NoMatchRegister (register path)
 *   patient [...]             → PatientMatchCard list
 *   bill ok                   → BillResolveCard
 *   bill 404                  → NoMatchRegister (bill miss; NOT register)
 *   error 5xx                 → Alert + Retry
 */
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";
import { ApiError } from "@/lib/utils";
import { PatientMatchCard } from "./PatientMatchCard";
import { BillResolveCard } from "./BillResolveCard";
import { NoMatchRegister } from "./NoMatchRegister";
import { RecentlyViewed } from "./RecentlyViewed";
import type {
  PatientSearchResult,
  BillLookupResult,
  RecentPatient,
  SearchKind,
} from "@/types";

interface SmartSearchResultsProps {
  /** The kind in effect (override ?? detection). */
  effectiveKind: SearchKind;
  /** The raw typed value (for no-match copy + register prefill). */
  typed: string;
  /** Whether any network query is enabled for the current input (min-length met). */
  active: boolean;

  // patient-search slice (useSmartSearch) — `patientResults` is the current
  // page; `patientTotal` is the full ranked match count (drives count + pager).
  patientResults: PatientSearchResult[] | undefined;
  patientTotal: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  onPrevPage: () => void;
  onNextPage: () => void;
  patientLoading: boolean;
  patientError: Error | null;

  // bill-lookup slice (useBillLookup)
  billResult: BillLookupResult | undefined;
  billLoading: boolean;
  billError: Error | null;

  // recently-viewed (idle state)
  recent: RecentPatient[];

  // actions
  onOpenPatient: (patientId: string) => void;
  onOpenVisit: (patientId: string, visitId: string) => void;
  onRegister: () => void;
  onClear: () => void;
  onClearRecent: () => void;
  onRetry: () => void;
}

function SkeletonRows() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((i) => (
        <Card key={i}>
          <CardContent className="flex items-center gap-3 p-4">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-2/3" />
            </div>
            <Skeleton className="h-9 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ErrorAlert({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>Search failed. Please try again.</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function is404(err: Error | null): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function SmartSearchResults(props: SmartSearchResultsProps) {
  const {
    effectiveKind,
    typed,
    active,
    patientResults,
    patientTotal,
    page,
    pageSize,
    hasMore,
    onPrevPage,
    onNextPage,
    patientLoading,
    patientError,
    billResult,
    billLoading,
    billError,
    recent,
    onOpenPatient,
    onOpenVisit,
    onRegister,
    onClear,
    onClearRecent,
    onRetry,
  } = props;

  // Idle: empty / below-min input → recently viewed (or nothing).
  if (!active) {
    return (
      <RecentlyViewed
        items={recent}
        onOpen={onOpenPatient}
        onClear={onClearRecent}
      />
    );
  }

  // --- bill path -----------------------------------------------------------
  if (effectiveKind === "bill") {
    if (billLoading) return <SkeletonRows />;
    if (is404(billError)) {
      return (
        <NoMatchRegister
          typed={typed}
          kind="bill"
          onRegister={onRegister}
          onClear={onClear}
        />
      );
    }
    if (billError) return <ErrorAlert onRetry={onRetry} />;
    if (billResult) {
      return (
        <BillResolveCard
          result={billResult}
          onOpenVisit={onOpenVisit}
          onOpenRecord={onOpenPatient}
        />
      );
    }
    return null;
  }

  // --- patient path --------------------------------------------------------
  if (patientLoading) return <SkeletonRows />;
  if (patientError) return <ErrorAlert onRetry={onRetry} />;
  if (patientResults && patientTotal === 0) {
    return (
      <NoMatchRegister
        typed={typed}
        kind={effectiveKind}
        onRegister={onRegister}
        onClear={onClear}
      />
    );
  }
  if (patientResults && patientResults.length > 0) {
    const totalPages = Math.ceil(patientTotal / pageSize);
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {patientTotal} {patientTotal === 1 ? "patient" : "patients"} found ·
          all branches · read-only
        </p>
        {patientResults.map((result) => (
          <PatientMatchCard
            key={result.patient.id}
            result={result}
            onOpen={onOpenPatient}
          />
        ))}
        {patientTotal > pageSize && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={onPrevPage}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={onNextPage}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    );
  }
  return null;
}

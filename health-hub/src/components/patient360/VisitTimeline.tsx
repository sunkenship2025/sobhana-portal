/**
 * VisitTimeline — flattens the infinite-query pages into month buckets, renders
 * VisitRows, a "Load older" button, and the empty / inline-error states (§2, §6).
 *
 * Earlier-loaded pages are preserved on a next-page failure (the inline Alert +
 * Retry sits at the footer; the rows above stay rendered).
 */
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingState } from "@/components/ui/loading-state";
import { AlertCircle, CalendarX } from "lucide-react";
import { VisitRow } from "./VisitRow";
import type { ReportAction } from "@/hooks/patient360/useReportActions";
import type { Patient360TimelinePage, VisitTimelineItem } from "@/types";

function monthKey(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

interface MonthBucket {
  label: string;
  items: VisitTimelineItem[];
}

function bucketByMonth(items: VisitTimelineItem[]): MonthBucket[] {
  const buckets: MonthBucket[] = [];
  let current: MonthBucket | null = null;
  for (const item of items) {
    const label = monthKey(item.createdAt);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      buckets.push(current);
    }
    current.items.push(item);
  }
  return buckets;
}

interface VisitTimelineProps {
  pages: Patient360TimelinePage[] | undefined;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  /** Inline error for a next-page failure (earlier pages stay rendered). */
  isError: boolean;
  onRetry: () => void;
  /** Whether any filter is currently applied (changes the empty-state copy). */
  filtersApplied: boolean;

  selectedVisitId: string | null;
  onSelectVisit: (item: VisitTimelineItem) => void;
  /** The visit with an in-flight report action, or null. */
  reportBusyVisitId: string | null;
  reportBusyAction: ReportAction | null;
  onViewReport: (item: VisitTimelineItem) => void;
  onJumpToOriginal: (visitId: string) => void;
  /** Lets the orchestrator scroll a located row into view (?visit= / jump). */
  registerRowRef?: (visitId: string, el: HTMLDivElement | null) => void;
}

export function VisitTimeline({
  pages,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  isError,
  onRetry,
  filtersApplied,
  selectedVisitId,
  onSelectVisit,
  reportBusyVisitId,
  reportBusyAction,
  onViewReport,
  onJumpToOriginal,
  registerRowRef,
}: VisitTimelineProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  const items = useMemo<VisitTimelineItem[]>(
    () => (pages ?? []).flatMap((p) => p.items),
    [pages],
  );
  const buckets = useMemo(() => bucketByMonth(items), [items]);

  return (
    <div>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="mb-4 flex items-center gap-2 text-lg font-semibold focus-visible:outline-none"
        data-timeline-heading
      >
        Visit timeline
        <span className="text-sm font-normal text-muted-foreground">(newest first)</span>
      </h2>

      {items.length === 0 && !isError ? (
        <EmptyState
          icon={CalendarX}
          title={filtersApplied ? "No visits match these filters" : "No visits recorded"}
          description={
            filtersApplied
              ? "Try clearing or widening the filters above."
              : "This patient has no visit history yet."
          }
        />
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => (
            <div key={bucket.label} className="space-y-3">
              <p className="sticky top-0 z-[1] bg-background/80 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                {bucket.label}
              </p>
              {bucket.items.map((item) => (
                <div
                  key={item.visitId}
                  ref={(el) => registerRowRef?.(item.visitId, el)}
                >
                  <VisitRow
                    item={item}
                    selected={selectedVisitId === item.visitId}
                    reportBusy={reportBusyVisitId === item.visitId}
                    reportBusyAction={
                      reportBusyVisitId === item.visitId ? reportBusyAction : null
                    }
                    onSelect={() => onSelectVisit(item)}
                    onViewReport={() => onViewReport(item)}
                    onJumpToOriginal={onJumpToOriginal}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Footer: inline error / load-older / fetching spinner. */}
      <div className="mt-4">
        {isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="flex items-center justify-between gap-3">
              <span>Couldn't load more visits.</span>
              <Button size="sm" variant="outline" onClick={onRetry}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : isFetchingNextPage ? (
          <LoadingState label="Loading older visits…" />
        ) : (
          hasNextPage &&
          items.length > 0 && (
            <Button variant="outline" className="w-full" onClick={onLoadMore}>
              Load older visits
            </Button>
          )
        )}
      </div>
    </div>
  );
}

import { Button } from "@/components/ui/button";

interface WorklistPagerProps {
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/**
 * Previous / "Page X of Y" / Next control for the paged worklists. Renders
 * nothing when everything fits on one page. Mirrors the Patient 360 search
 * pager so the paged experience is consistent across pages.
 */
export function WorklistPager({
  page,
  totalPages,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: WorklistPagerProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}>
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {page} of {totalPages}
      </span>
      <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
        Next
      </Button>
    </div>
  );
}

import { useEffect, useState } from "react";

const DEFAULT_PAGE_SIZE = 20;

/**
 * Client-side pagination for an already-filtered/ranked list. Slices the list
 * into 20-row pages and resets to page 1 whenever `resetKey` changes (e.g. the
 * search term or active filters), so a new query always starts on page 1.
 *
 * Keeps big worklists snappy (only a page of cards is rendered at a time) and
 * gives the queue pages the same paged UX as the Patient 360 search.
 */
export function usePagedList<T>(
  items: T[],
  resetKey: unknown,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Clamp: the list can shrink below the current page after a filter change.
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    page: safePage,
    totalPages,
    total,
    pageSize,
    pageItems,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    prev: () => setPage((p) => Math.max(1, p - 1)),
    next: () => setPage((p) => p + 1),
  };
}

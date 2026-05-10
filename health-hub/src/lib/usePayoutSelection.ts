/**
 * Selection hook for the payouts table.
 *
 * Supports the workflows the owner asked for:
 *   - bulk: click row 1, shift-click row 8 → rows 1..8 selected
 *   - random: cmd/ctrl-click individual rows → toggles only that row
 *   - select-all-on-page: header checkbox toggles all currently visible
 *   - select-all-matching-filters: separate "selectAllMatching" intent
 *     (the caller fetches the matching id list from the server and feeds
 *     it back via setMany)
 *
 * Selection persists across pagination (it's a Set of ids, not row indices).
 * Filter changes should call clear() — that's the consumer's responsibility.
 */
import { useCallback, useMemo, useRef, useState } from "react";

export interface UsePayoutSelectionOptions<T extends { id: string }> {
  rows: T[]; // current page rows (used for shift-click anchor + select-all)
}

export interface UsePayoutSelectionResult {
  selectedIds: Set<string>;
  selectedCount: number;
  isSelected: (id: string) => boolean;
  isAllOnPageSelected: boolean;
  isSomeOnPageSelected: boolean;
  toggle: (id: string, opts?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  toggleAllOnPage: () => void;
  setMany: (ids: string[]) => void;
  clear: () => void;
}

export function usePayoutSelection<T extends { id: string }>(
  options: UsePayoutSelectionOptions<T>
): UsePayoutSelectionResult {
  const { rows } = options;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastClickedRef = useRef<string | null>(null);

  const isSelected = useCallback(
    (id: string) => selectedIds.has(id),
    [selectedIds]
  );

  const isAllOnPageSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selectedIds.has(r.id)),
    [rows, selectedIds]
  );

  const isSomeOnPageSelected = useMemo(
    () => rows.some((r) => selectedIds.has(r.id)),
    [rows, selectedIds]
  );

  const toggle = useCallback(
    (id: string, opts?: { shiftKey?: boolean; metaKey?: boolean }) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        // Shift-click: range select between last-clicked and this row.
        // The anchor is the most recent toggle target.
        if (opts?.shiftKey && lastClickedRef.current && lastClickedRef.current !== id) {
          const startIdx = rows.findIndex((r) => r.id === lastClickedRef.current);
          const endIdx = rows.findIndex((r) => r.id === id);
          if (startIdx !== -1 && endIdx !== -1) {
            const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
            // The last-clicked row's state determines whether the range gets
            // added or removed: if anchor is selected, we ADD the range; if
            // anchor is unselected, we REMOVE the range. This matches the
            // intuitive "drag-select" feel.
            const anchorSelected = prev.has(lastClickedRef.current);
            for (let i = lo; i <= hi; i++) {
              if (anchorSelected) next.add(rows[i].id);
              else next.delete(rows[i].id);
            }
          }
        } else {
          // Plain click or cmd-click: toggle just this row.
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }

        return next;
      });
      lastClickedRef.current = id;
    },
    [rows]
  );

  const toggleAllOnPage = useCallback(() => {
    setSelectedIds((prev) => {
      const allSelected = rows.length > 0 && rows.every((r) => prev.has(r.id));
      const next = new Set(prev);
      if (allSelected) {
        for (const r of rows) next.delete(r.id);
      } else {
        for (const r of rows) next.add(r.id);
      }
      return next;
    });
  }, [rows]);

  const setMany = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    lastClickedRef.current = null;
  }, []);

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    isSelected,
    isAllOnPageSelected,
    isSomeOnPageSelected,
    toggle,
    toggleAllOnPage,
    setMany,
    clear,
  };
}

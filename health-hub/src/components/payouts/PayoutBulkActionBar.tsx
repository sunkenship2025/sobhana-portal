/**
 * Sticky action bar that appears when N>0 payouts are selected.
 *
 * Shown at the bottom of the page (sticky, above any footer). Hides itself
 * when count === 0. Owner-only actions (Delete) are gated by `isOwner`.
 */
import { CheckCircle2, Download, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRupees } from "@/lib/payoutFormatters";

export interface PayoutBulkActionBarProps {
  count: number;
  totalInPaise?: number;          // optional: sum of selected amounts
  isOwner: boolean;
  onDelete: () => void;
  onExport: () => void;
  onClear: () => void;
}

export function PayoutBulkActionBar({
  count,
  totalInPaise,
  isOwner,
  onDelete,
  onExport,
  onClear,
}: PayoutBulkActionBarProps) {
  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 pointer-events-none"
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border bg-background px-4 py-2.5 shadow-lg">
        <div className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <span className="font-medium">
            {count} selected
            {totalInPaise !== undefined ? (
              <span className="ml-2 text-muted-foreground">
                · {formatRupees(totalInPaise)}
              </span>
            ) : null}
          </span>
        </div>
        <div className="h-5 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={onExport}>
          <Download className="h-4 w-4 mr-1.5" />
          Export
        </Button>
        {isOwner && (
          <Button
            size="sm"
            variant="outline"
            onClick={onDelete}
            className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Delete
          </Button>
        )}
        <div className="h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          aria-label="Clear selection"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

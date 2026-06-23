/**
 * Selectable payouts table.
 *
 * Columns: ☐ · Doctor · Type · Period · Amount · Status · Derived On · Actions
 *
 * Row click = open detail. Checkbox click (with shift/cmd modifiers) = toggle
 * selection. The amount column is right-aligned (fixing one of the bugs from
 * the review). Status badges use the existing project palette.
 */
import { Check, Clock, Eye } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  formatRupees,
  formatDate,
  formatPeriod,
  formatDoctorTypeShort,
} from "@/lib/payoutFormatters";
import type { PayoutSummary, PayoutSortField, PayoutSortDir } from "@/types";
import type { UsePayoutSelectionResult } from "@/lib/usePayoutSelection";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";

export interface PayoutsTableProps {
  rows: PayoutSummary[];
  loading?: boolean;
  selection: UsePayoutSelectionResult;
  sortBy: PayoutSortField;
  sortDir: PayoutSortDir;
  onSortChange: (field: PayoutSortField) => void;
  onRowClick: (row: PayoutSummary) => void;
  onMarkPaid: (row: PayoutSummary) => void;
}

function SortHeader({
  label,
  field,
  current,
  dir,
  onChange,
  className,
}: {
  label: string;
  field: PayoutSortField;
  current: PayoutSortField;
  dir: PayoutSortDir;
  onChange: (f: PayoutSortField) => void;
  className?: string;
}) {
  const Icon =
    current === field
      ? dir === "asc"
        ? ArrowUp
        : ArrowDown
      : ArrowUpDown;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onChange(field)}
      className={cn("h-auto p-0 font-medium hover:bg-transparent", className)}
    >
      {label}
      <Icon className="ml-1.5 h-3.5 w-3.5 opacity-60" />
    </Button>
  );
}

export function PayoutsTable({
  rows,
  loading,
  selection,
  sortBy,
  sortDir,
  onSortChange,
  onRowClick,
  onMarkPaid,
}: PayoutsTableProps) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={
                  selection.isAllOnPageSelected
                    ? true
                    : selection.isSomeOnPageSelected
                      ? "indeterminate"
                      : false
                }
                onCheckedChange={() => selection.toggleAllOnPage()}
                aria-label="Select all on page"
              />
            </TableHead>
            <TableHead>
              <SortHeader
                label="Doctor"
                field="doctorName"
                current={sortBy}
                dir={sortDir}
                onChange={onSortChange}
              />
            </TableHead>
            <TableHead className="w-24 hidden md:table-cell">Type</TableHead>
            <TableHead className="hidden md:table-cell">
              <SortHeader
                label="Period"
                field="periodStart"
                current={sortBy}
                dir={sortDir}
                onChange={onSortChange}
              />
            </TableHead>
            <TableHead className="text-right">
              <SortHeader
                label="Amount"
                field="amount"
                current={sortBy}
                dir={sortDir}
                onChange={onSortChange}
                className="ml-auto"
              />
            </TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead className="hidden md:table-cell">
              <SortHeader
                label="Derived"
                field="derivedAt"
                current={sortBy}
                dir={sortDir}
                onChange={onSortChange}
              />
            </TableHead>
            <TableHead className="w-44 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {Array.from({ length: 8 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => {
                const checked = selection.isSelected(row.id);
                return (
                  <TableRow
                    key={row.id}
                    data-selected={checked || undefined}
                    className={cn(
                      "cursor-pointer",
                      checked && "bg-muted/40"
                    )}
                    onClick={(e) => {
                      // Don't open detail when clicking the checkbox cell or action buttons.
                      const target = e.target as HTMLElement;
                      if (
                        target.closest('[data-row-checkbox="true"]') ||
                        target.closest("[data-row-actions]")
                      ) {
                        return;
                      }
                      onRowClick(row);
                    }}
                  >
                    <TableCell
                      data-row-checkbox="true"
                      onClick={(e) => {
                        e.stopPropagation();
                        selection.toggle(row.id, {
                          shiftKey: e.shiftKey,
                          metaKey: e.metaKey || e.ctrlKey,
                        });
                      }}
                    >
                      <Checkbox checked={checked} aria-label="Select row" />
                    </TableCell>
                    <TableCell className="font-medium">{row.doctorName}</TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge
                        variant={
                          row.doctorType === "REFERRAL"
                            ? "default"
                            : row.doctorType === "CLINIC"
                              ? "secondary"
                              : "outline"
                        }
                        title={
                          row.doctorType === "DIAGNOSTIC_CENTER"
                            ? "Diagnostic Center"
                            : undefined
                        }
                      >
                        {formatDoctorTypeShort(row.doctorType)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {formatPeriod(row.periodStartDate, row.periodEndDate)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatRupees(row.derivedAmountInPaise)}
                    </TableCell>
                    <TableCell>
                      {row.paidAt ? (
                        <Badge
                          variant="outline"
                          className="bg-success/10 text-success border-success/20"
                        >
                          <Check className="h-3 w-3 mr-1" />
                          Paid
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="bg-warning/10 text-warning border-warning/20"
                        >
                          <Clock className="h-3 w-3 mr-1" />
                          Pending
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-muted-foreground">
                      {formatDate(row.derivedAt)}
                    </TableCell>
                    <TableCell data-row-actions className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowClick(row);
                          }}
                          aria-label="View details"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        {!row.paidAt && (
                          <Button
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              onMarkPaid(row);
                            }}
                          >
                            Mark Paid
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
        </TableBody>
      </Table>
    </div>
  );
}

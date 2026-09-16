import { useMemo } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  useApiQuery,
  useBranchId,
  apiCall,
  branchRequest,
  qk,
} from "@/lib/query";
import { formatRefDoctor } from "@/lib/patientDisplay";
import {
  type DateRangeState,
  type DatePreset,
  todayISO,
} from "@/lib/dateFilter";
import { cn } from "@/lib/utils";

/** Value meaning "no filter" on every picker in this bar. */
export const ANY = "all";
/** Doctor picker value for "billed with no referring doctor". */
export const SELF = "__self__";

/**
 * A page-specific dropdown (Payment, Stage, Waiting, Delivery…). Data-driven so
 * the bar renders the control AND its chip without knowing what it means —
 * `ANY` is always the inactive value.
 */
export interface ExtraFilter {
  key: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: Array<{ value: string; label: string }>;
}

interface DoctorLite {
  id: string;
  name: string;
}
interface ProductLite {
  id: string;
  name: string;
  code?: string;
}

const PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

interface WorklistFilterBarProps {
  dateRange: DateRangeState;
  onDateRange: (next: DateRangeState) => void;
  search: string;
  onSearch: (next: string) => void;
  doctorId: string;
  onDoctor: (next: string) => void;
  productId: string;
  onProduct: (next: string) => void;
  extras?: ExtraFilter[];
}

/**
 * The filter bar shared by the diagnostics worklists: date as one row of
 * segments, one search box, and everything rarer behind a "Filters" button that
 * carries a count. What is applied reads back as a row of chips — the old bar
 * hid an active doctor filter inside a dropdown still labelled "All doctors".
 *
 * Doctor and test options come from the same cached master lists the New Visit
 * form downloads (shared query keys), not from the rows on screen: the Finalized
 * list is paginated server-side, so the visible page is never the full set.
 */
export function WorklistFilterBar({
  dateRange,
  onDateRange,
  search,
  onSearch,
  doctorId,
  onDoctor,
  productId,
  onProduct,
  extras = [],
}: WorklistFilterBarProps) {
  const branchId = useBranchId();

  const { data: doctors = [] } = useApiQuery<DoctorLite[]>({
    queryKey: qk.referralDoctors(),
    queryFn: () => apiCall<DoctorLite[]>("/referral-doctors"),
    staleTime: 5 * 60_000,
  });

  const { data: products = [] } = useApiQuery<ProductLite[]>({
    branchScoped: true,
    queryKey: qk.billableProducts(branchId),
    queryFn: () => branchRequest<ProductLite[]>("/billable-products", branchId!),
    staleTime: 5 * 60_000,
  });

  const doctorOptions = useMemo(
    () => [
      { value: ANY, label: "All doctors" },
      // Walk-ins are a real slice of the day and had no way to be isolated.
      { value: SELF, label: "Self / walk-in (no doctor)" },
      ...doctors.map((d) => ({ value: d.id, label: formatRefDoctor(d.name) })),
    ],
    [doctors],
  );

  const testOptions = useMemo(
    () => [
      { value: ANY, label: "All tests" },
      ...products.map((p) => ({ value: p.id, label: p.name, keywords: p.code })),
    ],
    [products],
  );

  const doctorLabel = doctorOptions.find((o) => o.value === doctorId)?.label;
  const testLabel = testOptions.find((o) => o.value === productId)?.label;
  const activeExtras = extras.filter((e) => e.value !== ANY);

  const activeCount =
    (doctorId !== ANY ? 1 : 0) +
    (productId !== ANY ? 1 : 0) +
    activeExtras.length;

  const setPreset = (preset: DatePreset) => {
    if (preset === "custom") {
      // Seed a custom range to today→today so switching in narrows rather than
      // jumping to everything; keep dates the user already picked.
      const today = todayISO();
      onDateRange({
        preset,
        from: dateRange.from || today,
        to: dateRange.to || today,
      });
    } else {
      onDateRange({ ...dateRange, preset });
    }
  };

  const clearAll = () => {
    onDoctor(ANY);
    onProduct(ANY);
    for (const e of extras) e.onChange(ANY);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* Date — one click for the case that is most of the day's use. */}
        <div className="inline-flex h-10 shrink-0 overflow-hidden rounded-md border">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPreset(p.value)}
              aria-pressed={dateRange.preset === p.value}
              className={cn(
                "border-r px-3 text-sm transition-colors last:border-r-0",
                dateRange.preset === p.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="relative w-full flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            placeholder="Name, phone, P-number, bill, doctor or test…"
            aria-label="Search this worklist"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="shrink-0 justify-start">
              <SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden="true" />
              Filters
              {activeCount > 0 && (
                <Badge variant="secondary" className="ml-2 px-1.5">
                  {activeCount}
                </Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-4">
            <div className="space-y-2">
              <Label>Referred by</Label>
              <SearchableSelect
                value={doctorId}
                onValueChange={onDoctor}
                options={doctorOptions}
                placeholder="All doctors"
                searchPlaceholder="Search doctors..."
                emptyText="No doctors found."
                ariaLabel="Filter by referring doctor"
              />
            </div>
            <div className="space-y-2">
              <Label>Test</Label>
              <SearchableSelect
                value={productId}
                onValueChange={onProduct}
                options={testOptions}
                placeholder="All tests"
                searchPlaceholder="Search tests..."
                emptyText="No tests found."
                ariaLabel="Filter by test"
              />
            </div>
            {extras.map((e) => (
              <div key={e.key} className="space-y-2">
                <Label>{e.label}</Label>
                <Select value={e.value} onValueChange={e.onChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {e.options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      {/* Custom range — native pickers, so the counter phones get their OS one. */}
      {dateRange.preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="range-from" className="text-muted-foreground">
            From
          </Label>
          <Input
            id="range-from"
            type="date"
            className="w-auto"
            value={dateRange.from}
            max={dateRange.to || todayISO()}
            onChange={(e) => onDateRange({ ...dateRange, from: e.target.value })}
          />
          <Label htmlFor="range-to" className="text-muted-foreground">
            To
          </Label>
          <Input
            id="range-to"
            type="date"
            className="w-auto"
            value={dateRange.to}
            min={dateRange.from || undefined}
            max={todayISO()}
            onChange={(e) => onDateRange({ ...dateRange, to: e.target.value })}
          />
        </div>
      )}

      {/* What is actually applied — the old bar hid this inside the dropdowns. */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {doctorId !== ANY && (
            <FilterChip label="Dr" value={doctorLabel} onClear={() => onDoctor(ANY)} />
          )}
          {productId !== ANY && (
            <FilterChip label="Test" value={testLabel} onClear={() => onProduct(ANY)} />
          )}
          {activeExtras.map((e) => (
            <FilterChip
              key={e.key}
              label={e.label}
              value={e.options.find((o) => o.value === e.value)?.label}
              onClear={() => e.onChange(ANY)}
            />
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}

function FilterChip({
  label,
  value,
  onClear,
}: {
  label: string;
  value?: string;
  onClear: () => void;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border bg-muted/50 px-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="max-w-[16rem] truncate">{value}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} filter`}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

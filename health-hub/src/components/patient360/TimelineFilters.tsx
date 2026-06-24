/**
 * TimelineFilters — filter controls, 1:1 with the /360/timeline query params (§2).
 *
 * Domain segmented control · date range popover · branch select · "Unpaid only"
 * · "Show cancelled". Each change emits a new TimelineFilters object; because the
 * filter object lives in the timeline query key, any change resets the cursor to
 * the newest page (no manual cursor juggling — §5).
 *
 * Responsive (§8): on desktop everything is inline (flex-wrap). On mobile the
 * domain segmented control stays inline, and the secondary controls (date /
 * branch / unpaid / cancelled) collapse behind a "Filters" Drawer with an
 * active-count badge. vaul handles ESC/backdrop/drag + reduced-motion.
 */
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { CalendarDays, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/patient360/useIsMobile";
import type { TimelineFilters as TimelineFiltersValue, VisitDomain } from "@/types";

const ALL_BRANCHES = "__all__";

const DOMAIN_TABS: { value: VisitDomain | null; label: string }[] = [
  { value: null, label: "All" },
  { value: "DIAGNOSTICS", label: "Diagnostics" },
  { value: "CLINIC", label: "Clinic" },
];

interface TimelineFiltersProps {
  value: TimelineFiltersValue;
  onChange: (next: TimelineFiltersValue) => void;
  branches: { id: string; name: string }[];
}

/** Count of active SECONDARY filters (everything except the domain segmented
 *  control, which is always inline). Drives the mobile "Filters" badge. */
function secondaryActiveCount(v: TimelineFiltersValue): number {
  let n = 0;
  if (v.from || v.to) n += 1;
  if (v.branchId) n += 1;
  if (v.unpaidOnly) n += 1;
  if (v.includeCancelled) n += 1;
  return n;
}

export function TimelineFilters({ value, onChange, branches }: TimelineFiltersProps) {
  const isMobile = useIsMobile();
  const patch = (partial: Partial<TimelineFiltersValue>) => onChange({ ...value, ...partial });
  const dateActive = !!value.from || !!value.to;

  const domainControl = (
    <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Domain filter">
      {DOMAIN_TABS.map((tab) => {
        const active = value.domain === tab.value;
        return (
          <Button
            key={tab.label}
            type="button"
            size="sm"
            variant={active ? "default" : "ghost"}
            className={cn("h-7 px-3 text-xs", !active && "text-muted-foreground")}
            onClick={() => patch({ domain: tab.value })}
            aria-pressed={active}
          >
            {tab.label}
          </Button>
        );
      })}
    </div>
  );

  const dateControl = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn("h-8", dateActive && "border-primary text-primary")}
        >
          <CalendarDays className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {dateActive ? `${value.from || "…"} → ${value.to || "…"}` : "Date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="tf-from" className="text-xs">
            From
          </Label>
          <Input
            id="tf-from"
            type="date"
            value={value.from ?? ""}
            onChange={(e) => patch({ from: e.target.value || null })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tf-to" className="text-xs">
            To
          </Label>
          <Input
            id="tf-to"
            type="date"
            value={value.to ?? ""}
            onChange={(e) => patch({ to: e.target.value || null })}
          />
        </div>
        {dateActive && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={() => patch({ from: null, to: null })}
          >
            <X className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Clear dates
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );

  const branchControl = branches.length > 1 && (
    <Select
      value={value.branchId ?? ALL_BRANCHES}
      onValueChange={(v) => patch({ branchId: v === ALL_BRANCHES ? null : v })}
    >
      <SelectTrigger className="h-8 w-[160px] text-xs">
        <SelectValue placeholder="All branches" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_BRANCHES}>All branches</SelectItem>
        {branches.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const unpaidControl = (
    <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs">
      <Checkbox
        checked={value.unpaidOnly}
        onCheckedChange={(c) => patch({ unpaidOnly: c === true })}
      />
      Unpaid only
    </label>
  );

  const cancelledControl = (
    <label className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs">
      <Checkbox
        checked={value.includeCancelled}
        onCheckedChange={(c) => patch({ includeCancelled: c === true })}
      />
      Show cancelled
    </label>
  );

  // --- Mobile: domain inline + secondary controls in a Drawer ----------------
  if (isMobile) {
    const activeCount = secondaryActiveCount(value);
    return (
      <div className="flex flex-wrap items-center gap-2">
        {domainControl}
        <Drawer>
          <DrawerTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-8">
              <SlidersHorizontal className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Filters
              {activeCount > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-4 px-1.5 text-[10px]">
                  {activeCount}
                </Badge>
              )}
            </Button>
          </DrawerTrigger>
          <DrawerContent className="max-h-[85vh]">
            <DrawerHeader className="text-left">
              <DrawerTitle>Filters</DrawerTitle>
            </DrawerHeader>
            <div className="flex flex-col gap-4 px-4 pb-2">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Date range</p>
                {dateControl}
              </div>
              {branchControl && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">Branch</p>
                  {branchControl}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {unpaidControl}
                {cancelledControl}
              </div>
            </div>
            <DrawerFooter>
              {activeCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    patch({
                      from: null,
                      to: null,
                      branchId: null,
                      unpaidOnly: false,
                      includeCancelled: false,
                    })
                  }
                >
                  <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  Clear filters
                </Button>
              )}
              <DrawerClose asChild>
                <Button type="button">Done</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </div>
    );
  }

  // --- Desktop: everything inline (flex-wrap) --------------------------------
  return (
    <div className="flex flex-wrap items-center gap-2">
      {domainControl}
      {dateControl}
      {branchControl}
      {unpaidControl}
      {cancelledControl}
    </div>
  );
}

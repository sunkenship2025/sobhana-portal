/**
 * Date preset chip-row.
 *
 * One-click ranges that finance staff use most often:
 *   This Month · Last Month · Last 30 Days · This Quarter · Custom
 *
 * Picking "Custom" keeps the existing range; the consumer is expected to
 * render its own <Input type="date"/> pair when preset === "custom".
 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DatePreset } from "@/lib/usePayoutFiltersFromUrl";

const PRESETS: { value: DatePreset; label: string }[] = [
  { value: "this-month", label: "This Month" },
  { value: "last-month", label: "Last Month" },
  { value: "last-30-days", label: "Last 30 Days" },
  { value: "this-quarter", label: "This Quarter" },
  { value: "custom", label: "Custom" },
];

export interface DatePresetChipsProps {
  value: DatePreset;
  onChange: (preset: DatePreset) => void;
  className?: string;
}

export function DatePresetChips({ value, onChange, className }: DatePresetChipsProps) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {PRESETS.map((p) => (
        <Button
          key={p.value}
          variant={value === p.value ? "default" : "outline"}
          size="sm"
          className="h-7 px-2.5 text-xs"
          onClick={() => onChange(p.value)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
}

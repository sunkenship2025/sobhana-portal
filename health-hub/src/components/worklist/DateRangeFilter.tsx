import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DateRangeState,
  DatePreset,
  todayISO,
} from "@/lib/dateFilter";

interface DateRangeFilterProps {
  value: DateRangeState;
  onChange: (next: DateRangeState) => void;
  /** Width class for the preset trigger, to match each page's layout. */
  triggerClassName?: string;
}

/**
 * The "Date" filter used across the staff worklists: the familiar preset
 * dropdown plus a "Custom range" option that reveals inline From/To native date
 * pickers. Renders as flex-row siblings (a fragment) so From/To wrap naturally
 * next to the existing Search/Visit-Type controls. Native <input type="date">
 * gives the counter phones their OS date picker for free.
 */
export function DateRangeFilter({
  value,
  onChange,
  triggerClassName = "w-full sm:w-[180px]",
}: DateRangeFilterProps) {
  const setPreset = (preset: DatePreset) => {
    if (preset === "custom") {
      // Seed a fresh custom range to today→today so switching in narrows to a
      // sensible window rather than jumping to everything; keep any dates the
      // user already picked.
      const today = todayISO();
      onChange({
        preset,
        from: value.from || today,
        to: value.to || today,
      });
    } else {
      onChange({ ...value, preset });
    }
  };

  return (
    <>
      <div className="space-y-2">
        <Label>Date</Label>
        <Select
          value={value.preset}
          onValueChange={(v) => setPreset(v as DatePreset)}
        >
          <SelectTrigger className={triggerClassName}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="week">This Week</SelectItem>
            <SelectItem value="all">All Time</SelectItem>
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value.preset === "custom" && (
        <>
          <div className="space-y-2">
            <Label>From</Label>
            <Input
              type="date"
              className="w-full sm:w-[160px]"
              value={value.from}
              max={value.to || todayISO()}
              onChange={(e) => onChange({ ...value, from: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>To</Label>
            <Input
              type="date"
              className="w-full sm:w-[160px]"
              value={value.to}
              min={value.from || undefined}
              max={todayISO()}
              onChange={(e) => onChange({ ...value, to: e.target.value })}
            />
          </div>
        </>
      )}
    </>
  );
}

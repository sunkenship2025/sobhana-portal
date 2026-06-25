/**
 * SmartSearchBar — the smart search entry control (§2, §5, §8).
 *
 * Input + magnifier, a detection Badge that announces the SETTLED (debounced)
 * detection via aria-live="polite" (never per-keystroke — that would flood AT as
 * 9→98→987 flips name→phone), override pills to force a kind, and a Search
 * button. The parent owns the debounce/detection state via useSmartSearch and
 * passes the settled `detection` + the live `effectiveKind` down.
 */
import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Search,
  Phone,
  User,
  Mail,
  Hash,
  Receipt,
  type LucideIcon,
} from "lucide-react";
import type { SearchKind } from "@/types";

const KIND_META: Record<
  SearchKind,
  { label: string; icon: LucideIcon }
> = {
  phone: { label: "Phone", icon: Phone },
  name: { label: "Name", icon: User },
  email: { label: "Email", icon: Mail },
  patientNumber: { label: "Patient #", icon: Hash },
  bill: { label: "Bill", icon: Receipt },
};

// The pills a user can force. Ordered by how often staff reach for them
// (phone/name first, then bill; patient# and the rarely-collected email last).
const OVERRIDE_KINDS: SearchKind[] = [
  "phone",
  "name",
  "bill",
  "patientNumber",
  "email",
];

interface SmartSearchBarProps {
  rawQuery: string;
  onChange: (value: string) => void;
  /** The settled (debounced) detected kind — drives the aria-live announcement. */
  detection: SearchKind;
  /** The kind in effect right now (override ?? detection) — drives the badge. */
  effectiveKind: SearchKind;
  /** null clears any override and returns to auto-detect. */
  onOverride: (kind: SearchKind | null) => void;
  onSubmit: () => void;
  /** Whether an override is currently active (controls pill styling + reset). */
  overrideActive: boolean;
}

export function SmartSearchBar({
  rawQuery,
  onChange,
  detection,
  effectiveKind,
  onOverride,
  onSubmit,
  overrideActive,
}: SmartSearchBarProps) {
  // aria-live announcement is keyed on the SETTLED detection only.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    setAnnounced(rawQuery ? `Searching by ${KIND_META[detection].label}` : "");
  }, [detection, rawQuery]);

  const BadgeIcon = KIND_META[effectiveKind].icon;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={rawQuery}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
            placeholder="Search by phone, name, bill #, patient #, or email"
            aria-label="Search patients"
            className="pl-9 pr-28"
            autoFocus
          />
          {rawQuery && (
            <Badge
              variant="secondary"
              className="absolute right-2 top-1/2 -translate-y-1/2 gap-1 text-xs"
            >
              <BadgeIcon className="h-3 w-3" aria-hidden="true" />
              {KIND_META[effectiveKind].label}
            </Badge>
          )}
        </div>
        <Button className="w-full sm:w-auto" onClick={onSubmit}>
          <Search className="mr-2 h-4 w-4" />
          Search
        </Button>
      </div>

      {/* Override pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Search as:</span>
        {OVERRIDE_KINDS.map((kind) => {
          const { label, icon: Icon } = KIND_META[kind];
          const active = overrideActive && effectiveKind === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onOverride(active ? null : kind)}
              aria-pressed={active}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      {/* Settled-detection announcement (SR-only, polite). */}
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}

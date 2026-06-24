/**
 * RecentlyViewed — the localStorage recently-opened list, shown on the search
 * page when the input is empty. Each row opens the patient detail page; the list
 * is written from the detail page on a successful load (lib/recentPatients.ts).
 */
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Clock, ChevronRight } from "lucide-react";
import { formatPatientName } from "@/lib/patientDisplay";
import type { RecentPatient } from "@/types";

interface RecentlyViewedProps {
  items: RecentPatient[];
  onOpen: (patientId: string) => void;
  onClear: () => void;
}

export function RecentlyViewed({ items, onOpen, onClear }: RecentlyViewedProps) {
  if (items.length === 0) return null;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Clock className="h-4 w-4" aria-hidden="true" />
            Recently viewed
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-auto px-2 py-1 text-xs text-muted-foreground"
            onClick={onClear}
          >
            Clear
          </Button>
        </div>
        <ul className="divide-y">
          {items.map((item) => {
            const ageGender = [item.ageDisplay, item.gender].filter(Boolean).join(" · ");
            return (
              <li key={item.patientId}>
                <button
                  type="button"
                  onClick={() => onOpen(item.patientId)}
                  className="flex w-full items-center justify-between gap-2 py-2.5 text-left hover:text-primary"
                >
                  <span className="min-w-0">
                    <span className="truncate font-medium text-foreground">
                      {formatPatientName(item.name)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {" "}
                      · {item.patientNumber}
                      {ageGender ? ` · ${ageGender}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

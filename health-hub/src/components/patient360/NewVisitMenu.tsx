/**
 * NewVisitMenu — dropdown deep-linking into the new-visit flow (§2, §4).
 *
 * Each domain goes to ITS OWN page — /diagnostics/new or /clinic/new — carrying
 * { prefillPatientId, prefillPatient } in location.state. It used to send both
 * to /clinic/new and pass prefillDomain for the page to sort out, but nothing
 * read prefillDomain, so picking "Diagnostic visit" opened the clinic form.
 *
 * Plain buttons, not a cmdk Command. A Command is a search palette: with no
 * CommandInput its filter had nothing to match these two items against, so the
 * popover opened empty and the button looked dead. Two fixed choices need a
 * list, not a search engine.
 *
 * `enabledDomains` is OPTIONAL and defaults to ALL domains. Per MEMORY we do NOT
 * build a per-tenant toggle framework here — the prop is the seam for Axora to
 * pass a real enabled-domain list later (06-frontend-plan.md Q4).
 */
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChevronRight, Plus } from "lucide-react";
import type { Patient, VisitDomain } from "@/types";

const ALL_DOMAINS: VisitDomain[] = ["DIAGNOSTICS", "CLINIC"];

const DOMAIN_LABEL: Record<VisitDomain, string> = {
  DIAGNOSTICS: "Diagnostic visit",
  CLINIC: "Clinic visit",
};

interface NewVisitMenuProps {
  patientId: string;
  patient?: Patient;
  enabledDomains?: VisitDomain[];
}

export function NewVisitMenu({ patientId, patient, enabledDomains }: NewVisitMenuProps) {
  const navigate = useNavigate();
  const domains = enabledDomains && enabledDomains.length > 0 ? enabledDomains : ALL_DOMAINS;

  const startVisit = (domain: VisitDomain) => {
    navigate(domain === "DIAGNOSTICS" ? "/diagnostics/new" : "/clinic/new", {
      state: { prefillPatientId: patientId, prefillPatient: patient },
    });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm">
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          New visit
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-1">
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Start a new visit</p>
        {domains.map((domain) => (
          <button
            key={domain}
            type="button"
            onClick={() => startVisit(domain)}
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <span>{DOMAIN_LABEL[domain]}</span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

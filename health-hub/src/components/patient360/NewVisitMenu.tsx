/**
 * NewVisitMenu — dropdown deep-linking into the new-visit flow (§2, §4).
 *
 * Navigates to /clinic/new (the verified canonical route — there is NO
 * /clinic/new-visit) carrying { prefillPatientId, prefillPatient, prefillDomain }
 * in location.state. ClinicNewVisit reads this via its prefill reader.
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
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
    navigate("/clinic/new", {
      state: {
        prefillPatientId: patientId,
        prefillPatient: patient,
        prefillDomain: domain,
      },
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
      <PopoverContent align="end" className="w-56 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading="Start a new visit">
              {domains.map((domain) => (
                <CommandItem
                  key={domain}
                  onSelect={() => startVisit(domain)}
                  className="flex items-center justify-between"
                >
                  <span>{DOMAIN_LABEL[domain]}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

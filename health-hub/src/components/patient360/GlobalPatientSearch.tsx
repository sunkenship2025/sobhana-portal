/**
 * Global Patient Search Component
 * 
 * Search by phone / patient number / name
 * Results route to Patient 360 (never directly to visit or report)
 * 
 * RULES:
 * - Global search (not branch-scoped)
 * - Results may include patients with no activity in current branch
 * - Forces explicit patient selection (no auto-merge)
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useDebounce } from '@/hooks/use-debounce';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Search, User, Phone, Hash } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

interface PatientSearchResult {
  id: string;
  patientNumber: string;
  name: string;
  age: number;
  gender: string;
  phone?: string;
  hasVisits: boolean;
}

async function searchPatients(
  query: string, 
  token: string
): Promise<PatientSearchResult[]> {
  if (!query || query.length < 2) return [];

  // Determine search type
  const isPhone = /^\d+$/.test(query);
  const isPatientNumber = /^P-?\d+$/i.test(query);

  const params = new URLSearchParams();
  if (isPatientNumber) {
    params.set('patientNumber', query);
  } else if (isPhone) {
    params.set('phone', query);
  } else {
    params.set('name', query);
  }

  const res = await fetch(`${API_BASE}/patients/search/global?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) return [];
  return res.json();
}

interface GlobalPatientSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GlobalPatientSearch({ open, onOpenChange }: GlobalPatientSearchProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);
  const navigate = useNavigate();
  const { token } = useAuthStore();

  const { data: results = [], isLoading } = useQuery({
    queryKey: ['patientSearch', debouncedQuery],
    queryFn: () => searchPatients(debouncedQuery, token!),
    enabled: debouncedQuery.length >= 2 && !!token,
  });

  const handleSelect = useCallback((patient: PatientSearchResult) => {
    navigate(`/patients/${patient.id}`);
    onOpenChange(false);
    setQuery('');
  }, [navigate, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput 
        placeholder="Search by name, phone, or patient number..." 
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {isLoading && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Searching...
          </div>
        )}
        
        {!isLoading && query.length >= 2 && results.length === 0 && (
          <CommandEmpty>No patients found.</CommandEmpty>
        )}
        
        {!isLoading && results.length > 0 && (
          <CommandGroup heading="Patients">
            {results.map((patient) => (
              <CommandItem
                key={patient.id}
                value={patient.id}
                onSelect={() => handleSelect(patient)}
                className="cursor-pointer"
              >
                <div className="flex items-center gap-3 w-full">
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <User className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{patient.name}</span>
                      <Badge variant="outline" className="text-xs font-mono">
                        {patient.patientNumber}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{patient.age}y / {patient.gender}</span>
                      {patient.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {patient.phone}
                        </span>
                      )}
                    </div>
                  </div>
                  {!patient.hasVisits && (
                    <Badge variant="secondary" className="text-xs">
                      No visits
                    </Badge>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {query.length < 2 && (
          <div className="py-6 text-center text-sm text-muted-foreground">
            <p>Type at least 2 characters to search</p>
            <div className="flex justify-center gap-4 mt-3 text-xs">
              <span className="flex items-center gap-1">
                <User className="h-3 w-3" /> Name
              </span>
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> Phone
              </span>
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" /> P-00001
              </span>
            </div>
          </div>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/**
 * Search trigger button for use in headers/navbars
 */
interface SearchTriggerProps {
  onClick: () => void;
}

export function PatientSearchTrigger({ onClick }: SearchTriggerProps) {
  return (
    <Button
      variant="outline"
      className="relative h-9 w-full justify-start text-sm text-muted-foreground sm:pr-12 md:w-40 lg:w-64"
      onClick={onClick}
    >
      <Search className="mr-2 h-4 w-4" />
      <span className="hidden lg:inline-flex">Search patients...</span>
      <span className="inline-flex lg:hidden">Search...</span>
      <kbd className="pointer-events-none absolute right-1.5 top-1.5 hidden h-6 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium opacity-100 sm:flex">
        <span className="text-xs">⌘</span>K
      </kbd>
    </Button>
  );
}

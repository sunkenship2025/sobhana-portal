import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Search, Phone, User, Eye } from 'lucide-react';
import { apiRequest } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';
import type { PatientSearchResult, VisitDomain } from '@/types';
import { API_BASE } from '@/lib/api';

// API call for patient search
const searchPatients = async (
  searchType: 'phone' | 'name',
  query: string
): Promise<PatientSearchResult[]> => {
  const params = new URLSearchParams();
  if (searchType === 'phone') {
    params.set('phone', query);
  } else {
    params.set('name', query);
  }

  const branchId = useBranchStore.getState().activeBranchId || 'cmjzumgap00003zwljoqlubsn';
  return apiRequest<PatientSearchResult[]>(`${API_BASE}/patients/search?${params}`, {
    headers: {
      'x-branch-id': branchId, // Use valid branch ID from store
    },
  });
};

function getDomainLabel(domain: VisitDomain, visitType?: 'OP' | 'IP'): string {
  if (domain === 'DIAGNOSTICS') return 'Diagnostic Visit';
  if (visitType === 'IP') return 'Clinic IP Visit';
  return 'Clinic OP Visit';
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function GlobalPatientSearch() {
  const navigate = useNavigate();
  const [searchType, setSearchType] = useState<'phone' | 'name'>('phone');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PatientSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;

    setIsSearching(true);
    setError(null);
    try {
      const data = await searchPatients(searchType, query.trim());
      setResults(data);
      setHasSearched(true);
    } catch (error: any) {
      console.error('Search failed:', error);
      setError(error.message || 'Search failed. Please try again.');
      setResults([]);
      setHasSearched(true);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleViewPatient360 = (patientId: string) => {
    navigate(`/clinic/patient-360/${patientId}`);
  };

  return (
    <AppLayout context="clinic" subContext="Global Patient Search">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground">Global Patient Search</h1>
          <p className="text-muted-foreground mt-1">
            Find a patient across all branches
          </p>
        </div>

        {/* Search Form */}
        <Card>
          <CardContent className="pt-6">
            {/* Search Type Tabs */}
            <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:gap-4">
              <Button
                variant={searchType === 'phone' ? 'default' : 'outline'}
                onClick={() => setSearchType('phone')}
                className="flex-1"
              >
                <Phone className="h-4 w-4 mr-2" />
                Search by Phone (recommended)
              </Button>
              <Button
                variant={searchType === 'name' ? 'default' : 'outline'}
                onClick={() => setSearchType('name')}
                className="flex-1"
              >
                <User className="h-4 w-4 mr-2" />
                Search by Name
              </Button>
            </div>

            {/* Search Input */}
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                placeholder={
                  searchType === 'phone'
                    ? 'Enter phone number...'
                    : 'Enter patient name...'
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="flex-1"
              />
              <Button className="w-full sm:w-auto" onClick={handleSearch} disabled={isSearching || !query.trim()}>
                <Search className="h-4 w-4 mr-2" />
                {isSearching ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Results Header */}
        {hasSearched && (
          <div className="flex flex-wrap items-center gap-2 border-b pb-2 text-sm text-muted-foreground">
            <span className="font-medium">SEARCH RESULTS</span>
            <span>•</span>
            <span>GLOBAL</span>
            <span>•</span>
            <span>READ-ONLY</span>
            {results.length > 0 && (
              <>
                <span className="ml-auto">{results.length} patient(s) found</span>
              </>
            )}
          </div>
        )}

        {/* Search Results */}
        {hasSearched && results.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <User className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No patients found matching your search.</p>
              <p className="text-sm mt-1">Try a different phone number or name.</p>
            </CardContent>
          </Card>
        )}

        {/* Patient Cards */}
        <div className="space-y-4">
          {results.map((result) => (
            <Card key={result.patient.id} className="overflow-hidden">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                      {result.patient.name}
                      <span className="text-muted-foreground font-normal">|</span>
                      <span className="text-muted-foreground font-normal">
                        {(result.patient as any).ageDisplay || result.patient.age}
                      </span>
                      <span className="text-muted-foreground font-normal">|</span>
                      <span className="text-muted-foreground font-normal">
                        {result.patient.gender}
                      </span>
                    </CardTitle>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Phone:{' '}
                      {result.patient.identifiers.find((i) => i.type === 'PHONE')?.value || 'N/A'}
                    </p>
                  </div>
                  <Badge variant="outline" className="w-fit text-xs">
                    {result.patient.patientNumber}
                  </Badge>
                </div>
              </CardHeader>

              <CardContent className="pt-0">
                {/* History Snapshot */}
                <div className="bg-muted/50 rounded-lg p-4 mb-4">
                  <h4 className="text-sm font-medium text-muted-foreground mb-3">
                    HISTORY SNAPSHOT
                  </h4>
                  {result.historySnapshot.length > 0 ? (
                    <ul className="space-y-2">
                      {result.historySnapshot.slice(0, 3).map((visit, idx) => (
                        <li key={idx} className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-muted-foreground">•</span>
                          <span className="font-medium">
                            {getDomainLabel(visit.domain, visit.visitType)}
                          </span>
                          <span className="text-muted-foreground">—</span>
                          <span>{visit.branchName}</span>
                          <span className="text-muted-foreground">—</span>
                          <span className="text-muted-foreground">
                            {formatDate(visit.createdAt)}
                          </span>
                        </li>
                      ))}
                      {result.totalVisits > 3 && (
                        <li className="text-sm text-muted-foreground pl-4">
                          ... and {result.totalVisits - 3} more visit(s)
                        </li>
                      )}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No visit history</p>
                  )}
                </div>

                {/* View Patient 360 Button */}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => handleViewPatient360(result.patient.id)}
                >
                  <Eye className="h-4 w-4 mr-2" />
                  View Patient 360
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </AppLayout>
  );
}

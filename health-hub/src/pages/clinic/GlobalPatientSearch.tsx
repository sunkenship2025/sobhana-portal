/**
 * GlobalPatientSearch — the Patient360 smart search entry page (§2, Group C).
 *
 * Hosts the SmartSearchBar + SmartSearchResults. Auto-detects the search kind
 * (phone/name/email/patientNumber/bill) with live debounced type-ahead, override
 * pills, recently-viewed on empty input, bill→visit resolve, and no-match→
 * register (carrying the typed value into the new-visit flow).
 *
 * Cross-branch GLOBAL view (binding decision 1): the search hooks go through
 * `apiCall` with NO branch header — there is no hardcoded fallback branchId, no
 * phone/name toggle, and no manual "submitted" state. The query fires off the
 * debounced input; the Search button + Enter only re-focus/force the same query.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import {
  getRecentPatients,
  clearRecentPatients,
} from "@/lib/recentPatients";
import { useSmartSearch, useBillLookup } from "@/hooks/patient360/usePatient360";
import { SmartSearchBar } from "@/components/patient360/SmartSearchBar";
import { SmartSearchResults } from "@/components/patient360/SmartSearchResults";
import type { SearchKind } from "@/types";

export default function GlobalPatientSearch() {
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id);
  const branches = useBranchStore((s) => s.branches);
  const activeBranchId = useBranchStore((s) => s.activeBranchId);
  const activeBranches = useMemo(
    () => branches.filter((b) => b.isActive),
    [branches],
  );

  const [rawQuery, setRawQuery] = useState("");
  // null = auto-detect; a SearchKind = forced via an override pill.
  const [override, setOverride] = useState<SearchKind | null>(null);
  // Branch scope: null = all branches (global). Defaults to the header's active
  // branch so search starts scoped to where the user is working; "All branches"
  // restores the original cross-branch behavior.
  const [scope, setScope] = useState<string | null>(activeBranchId);
  // 1-based page for the ranked name results. Reset to 1 synchronously whenever
  // the query text or override changes (below) so a new search starts on page 1.
  const [page, setPage] = useState(1);
  // Bumped to re-read localStorage after a clear (recently-viewed is read on
  // every render but localStorage writes from the detail page need a nudge).
  const [recentNonce, setRecentNonce] = useState(0);

  // Patient-search slice (phone/name/email/patientNumber). The hook owns the
  // 300ms debounce + detection + type-gated placeholderData. `scope` narrows
  // the (otherwise global) search to one branch when set.
  const search = useSmartSearch(rawQuery, override ?? undefined, page, scope);
  const scopeBranch = scope ? branches.find((b) => b.id === scope) : null;
  const effectiveKind = search.effectiveKind;
  const detectedKind = search.detectedKind;

  // Bill slice: only enabled when the effective kind is bill and we have a value.
  const bill = useBillLookup(
    search.billValue ?? undefined,
    effectiveKind === "bill",
  );

  const recent = useMemo(
    () => getRecentPatients(userId),
    // recentNonce forces a re-read after Clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, recentNonce],
  );

  // "active" = a network query is enabled for the current input (min-length met
  // for the patient path, or a value present for the bill path).
  const active =
    effectiveKind === "bill" ? !!search.billValue : search.active;

  const openPatient = (patientId: string) =>
    navigate(`/clinic/patient-360/${patientId}`);

  const openVisit = (patientId: string, visitId: string) =>
    navigate(`/clinic/patient-360/${patientId}?visit=${visitId}`);

  const register = () => {
    // Carry the typed value into the new-visit flow (Group C step 14b reader).
    // For a phone search we know it's a phone; otherwise pass the raw text.
    const kind: SearchKind = effectiveKind;
    navigate("/clinic/new", {
      state: { prefill: { kind, value: rawQuery.trim() } },
    });
  };

  const clear = () => {
    setRawQuery("");
    setOverride(null);
    setPage(1);
  };

  const clearRecent = () => {
    clearRecentPatients(userId);
    setRecentNonce((n) => n + 1);
  };

  const retry = () => {
    if (effectiveKind === "bill") bill.refetch();
    else search.refetch();
  };

  return (
    <AppLayout context="clinic" subContext="Patient 360">
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader
          title="Patient 360"
          subtitle={
            scopeBranch
              ? `Searching patients in ${scopeBranch.name}`
              : "Search any patient across all Sobhana branches"
          }
          className="mb-2"
        />

        <Card>
          <CardContent className="pt-6">
            <SmartSearchBar
              rawQuery={rawQuery}
              onChange={(v) => {
                setRawQuery(v);
                // Editing text resets any active override (§5) and the pager.
                if (override) setOverride(null);
                setPage(1);
              }}
              detection={detectedKind}
              effectiveKind={effectiveKind}
              overrideActive={override !== null}
              onOverride={(k) => {
                setOverride(k);
                setPage(1);
              }}
              onSubmit={retry}
              branches={activeBranches}
              scope={scope}
              onScopeChange={(branchId) => {
                setScope(branchId);
                setPage(1);
              }}
            />
          </CardContent>
        </Card>

        <SmartSearchResults
          effectiveKind={effectiveKind}
          typed={rawQuery.trim()}
          active={active}
          patientResults={search.results}
          patientTotal={search.total}
          page={page}
          pageSize={search.pageSize}
          hasMore={search.hasMore}
          onPrevPage={() => setPage((p) => Math.max(1, p - 1))}
          onNextPage={() => setPage((p) => p + 1)}
          // Skeleton only when there's nothing to show yet — during page flips
          // the previous page stays visible (placeholderData) instead of a flash.
          patientLoading={
            search.isFetching &&
            active &&
            effectiveKind !== "bill" &&
            search.results.length === 0
          }
          patientError={effectiveKind !== "bill" ? search.error : null}
          billResult={bill.data}
          billLoading={bill.isFetching && effectiveKind === "bill"}
          billError={effectiveKind === "bill" ? bill.error : null}
          recent={recent}
          onOpenPatient={openPatient}
          onOpenVisit={openVisit}
          onRegister={register}
          onClear={clear}
          onClearRecent={clearRecent}
          onRetry={retry}
        />
      </div>
    </AppLayout>
  );
}

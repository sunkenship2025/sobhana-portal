/**
 * Patient360 — detail-page ORCHESTRATOR (06-frontend-plan.md Groups D+E, §4).
 *
 * Read-only global patient view: sticky header + glance strip + two-pane body
 * (timeline ← infinite scroll | inspector →) on desktop; single column + bottom
 * Drawer inspector on mobile. Owns selectedVisitId / inspectorOpen / filters
 * state, reads ?visit=, and routes skeleton / 404 / network-error / content.
 *
 * The page hosts useReportActions (so the preview blob survives the desktop↔
 * mobile inspector swap and the hook can revoke on isMobile change — §3.3).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { ApiError } from "@/lib/utils";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { addRecentPatient } from "@/lib/recentPatients";
import {
  usePatient360Summary,
  usePatient360Timeline,
} from "@/hooks/patient360/usePatient360";
import { useReportActions } from "@/hooks/patient360/useReportActions";
import { useIsMobile } from "@/hooks/patient360/useIsMobile";
import { PatientHeaderBar } from "@/components/patient360/PatientHeaderBar";
import { GlanceStrip } from "@/components/patient360/GlanceStrip";
import { TimelineFilters } from "@/components/patient360/TimelineFilters";
import { VisitTimeline } from "@/components/patient360/VisitTimeline";
import { VisitInspector } from "@/components/patient360/VisitInspector";
import { Patient360LoadingSkeleton } from "@/components/patient360/Patient360LoadingSkeleton";
import { Patient360ErrorState } from "@/components/patient360/Patient360ErrorState";
import type { TimelineFilters as TimelineFiltersValue, VisitTimelineItem } from "@/types";

const EMPTY_FILTERS: TimelineFiltersValue = {
  domain: null,
  from: null,
  to: null,
  branchId: null,
  unpaidOnly: false,
  includeCancelled: false,
};

const LOCATE_PAGE_CAP = 10;

function filtersApplied(f: TimelineFiltersValue): boolean {
  return (
    !!f.domain || !!f.from || !!f.to || !!f.branchId || f.unpaidOnly || f.includeCancelled
  );
}

export default function Patient360() {
  const { patientId } = useParams<{ patientId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore((s) => s.user?.id);
  const isMobile = useIsMobile();

  const [filters, setFilters] = useState<TimelineFiltersValue>(EMPTY_FILTERS);
  const [selectedVisitId, setSelectedVisitId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const reportActions = useReportActions(isMobile);
  const summary = usePatient360Summary(patientId);
  const timeline = usePatient360Timeline(patientId, filters);

  const rowRefs = useRef(new Map<string, HTMLDivElement | null>());
  const locatedDeepLink = useRef(false);

  const allItems: VisitTimelineItem[] = (timeline.data?.pages ?? []).flatMap((p) => p.items);
  const selectedVisit = allItems.find((v) => v.visitId === selectedVisitId) ?? null;

  const goBack = useCallback(() => navigate("/clinic/patient-search"), [navigate]);

  const selectVisit = useCallback((item: VisitTimelineItem) => {
    setSelectedVisitId(item.visitId);
    setInspectorOpen(true);
    requestAnimationFrame(() =>
      rowRefs.current
        .get(item.visitId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }, []);

  // Bounded auto-locate (?visit= + jump-to-original): select if loaded; else
  // clear filters + fetchNextPage capped at LOCATE_PAGE_CAP; else toast. Never hangs.
  const locateVisit = useCallback(
    async (visitId: string) => {
      const loaded = (timeline.data?.pages ?? []).some((p) =>
        p.items.some((i) => i.visitId === visitId),
      );
      if (loaded) {
        const item = (timeline.data?.pages ?? [])
          .flatMap((p) => p.items)
          .find((i) => i.visitId === visitId);
        if (item) selectVisit(item);
        return;
      }
      if (filtersApplied(filters)) setFilters(EMPTY_FILTERS);
      let iterations = 0;
      while (iterations < LOCATE_PAGE_CAP && timeline.hasNextPage) {
        const res = await timeline.fetchNextPage();
        iterations += 1;
        const found = (res.data?.pages ?? [])
          .flatMap((p) => p.items)
          .find((i) => i.visitId === visitId);
        if (found) {
          selectVisit(found);
          return;
        }
      }
      toast.message("Couldn't locate that visit", {
        description: "It may be filtered out or no longer available.",
      });
    },
    [filters, selectVisit, timeline],
  );

  // ?visit= deep-link: run once after the first timeline page resolves.
  useEffect(() => {
    const target = searchParams.get("visit");
    if (!target || locatedDeepLink.current || timeline.isPending || !timeline.data) return;
    locatedDeepLink.current = true;
    void locateVisit(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, timeline.isPending, timeline.data]);

  // Recently-viewed: record on successful summary load.
  useEffect(() => {
    const p = summary.data?.patient;
    if (!p || !userId) return;
    addRecentPatient(userId, {
      patientId: p.id,
      name: p.name,
      patientNumber: p.patientNumber,
      ageDisplay: p.ageDisplay,
      gender: p.gender,
    });
  }, [summary.data?.patient, userId]);

  // --- routing: skeleton / error / content ---------------------------------
  if (summary.isPending && summary.isFetching) {
    return (
      <AppLayout context="clinic" subContext="Patient 360">
        <Patient360LoadingSkeleton />
      </AppLayout>
    );
  }

  if (summary.isError || !summary.data) {
    const notFound = summary.error instanceof ApiError && summary.error.status === 404;
    return (
      <AppLayout context="clinic" subContext="Patient 360">
        <Patient360ErrorState
          kind={notFound ? "not-found" : "network"}
          onRetry={notFound ? undefined : () => summary.refetch()}
          onBack={goBack}
        />
      </AppLayout>
    );
  }

  const { patient, glance, branches } = summary.data;
  const phone = patient.identifiers?.find((i) => i.type === "PHONE")?.value;

  // Close + return focus to the originating row's clickable region (§8). If that
  // row unmounted (e.g. a filter changed while the inspector was open, detaching
  // the saved node), fall back to the timeline heading so focus is never lost.
  const closeInspector = () => {
    const originating = selectedVisitId;
    setInspectorOpen(false);
    setSelectedVisitId(null);
    requestAnimationFrame(() => {
      const rowNode = originating ? rowRefs.current.get(originating) : null;
      if (rowNode && document.body.contains(rowNode)) {
        (rowNode.querySelector<HTMLElement>("button[aria-pressed]") ?? rowNode).focus();
      } else {
        document.querySelector<HTMLElement>("[data-timeline-heading]")?.focus();
      }
    });
  };

  return (
    <AppLayout context="clinic" subContext="Patient 360">
      <div className="space-y-5">
        <PatientHeaderBar
          patient={patient}
          branchCount={branches.length}
          onBack={goBack}
          onPatientUpdated={() => {
            /* Cache refresh handled by usePatientIdentityEdit's scoped summary
               invalidation (§3.4) — no full page reload here. */
          }}
        />

        <GlanceStrip glance={glance} patientId={patient.id} patient={patient} />

        <TimelineFilters value={filters} onChange={setFilters} branches={branches} />

        <div className="lg:grid lg:grid-cols-[1.35fr_1fr] lg:gap-5">
          <VisitTimeline
            pages={timeline.data?.pages}
            isFetchingNextPage={timeline.isFetchingNextPage}
            hasNextPage={!!timeline.hasNextPage}
            onLoadMore={() => timeline.fetchNextPage()}
            isError={timeline.isError}
            onRetry={() => timeline.refetch()}
            filtersApplied={filtersApplied(filters)}
            selectedVisitId={selectedVisitId}
            onSelectVisit={selectVisit}
            reportBusyVisitId={reportActions.busy?.visitId ?? null}
            reportBusyAction={reportActions.busy?.action ?? null}
            onViewReport={(item) => {
              selectVisit(item);
              void reportActions.viewReport(item.visitId);
            }}
            onJumpToOriginal={(id) => void locateVisit(id)}
            registerRowRef={(id, el) => rowRefs.current.set(id, el)}
          />

          {!isMobile && (
            <VisitInspector
              visit={selectedVisit}
              open={inspectorOpen}
              onClose={closeInspector}
              patientPhone={phone}
              isMobile={false}
              reportActions={reportActions}
            />
          )}
        </div>

        {isMobile && (
          <VisitInspector
            visit={selectedVisit}
            open={inspectorOpen}
            onClose={closeInspector}
            patientPhone={phone}
            isMobile
            reportActions={reportActions}
          />
        )}
      </div>
    </AppLayout>
  );
}

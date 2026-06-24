/**
 * GlanceStrip — the four-cell at-a-glance summary (§2, §6, §8).
 *
 * Cells: Last visit · Outstanding due (headline, ▲ when > 0) · Reports
 * ({finalized}✓ · {notFinalized} pending) · NewVisitMenu. The glance is
 * page-independent (backend aggregate) so it never refetches on timeline paging.
 *
 * Mobile: 2×2 with Due first (§8). Desktop: 4 cells in a row.
 */
import { Card } from "@/components/ui/card";
import { ArrowUpRight, CheckCircle2, Clock, IndianRupee } from "lucide-react";
import { NewVisitMenu } from "./NewVisitMenu";
import { formatCurrency } from "@/lib/patientDisplay";
import { cn } from "@/lib/utils";
import type { Patient, Patient360Glance, VisitDomain } from "@/types";

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function Cell({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-4", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1.5">{children}</div>
    </Card>
  );
}

interface GlanceStripProps {
  glance: Patient360Glance;
  patientId: string;
  patient?: Patient;
  enabledDomains?: VisitDomain[];
}

export function GlanceStrip({ glance, patientId, patient, enabledDomains }: GlanceStripProps) {
  const due = glance.outstandingDueInPaise;
  const { finalized, notFinalized } = glance.reportCounts;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* Due first on mobile (order-first), but stays in natural slot on desktop. */}
      <Cell label="Outstanding due" className="order-first lg:order-none">
        <div
          className={cn(
            "flex items-center gap-1 text-2xl font-bold",
            due > 0 ? "text-destructive" : "text-foreground",
          )}
        >
          <IndianRupee className="h-5 w-5 shrink-0" aria-hidden="true" />
          <span>{formatCurrency(due).replace("₹", "")}</span>
          {due > 0 && <ArrowUpRight className="h-5 w-5 shrink-0" aria-hidden="true" />}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {due > 0 ? "across open bills" : "all settled"}
        </p>
      </Cell>

      <Cell label="Last visit">
        {glance.lastVisit ? (
          <>
            <p className="text-sm font-semibold">{formatDate(glance.lastVisit.createdAt)}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {glance.lastVisit.domain === "DIAGNOSTICS" ? "Diagnostics" : "Clinic"} ·{" "}
              {glance.lastVisit.branchName}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No visits</p>
        )}
      </Cell>

      <Cell label="Reports">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1 font-semibold">
            <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
            {finalized}
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Clock className="h-4 w-4" aria-hidden="true" />
            {notFinalized} pending
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {glance.totalVisits} visit{glance.totalVisits === 1 ? "" : "s"}
        </p>
      </Cell>

      <Cell label="Actions">
        <NewVisitMenu patientId={patientId} patient={patient} enabledDomains={enabledDomains} />
      </Cell>
    </div>
  );
}

/**
 * Run Monthly Cycle — guided bulk-derive flow.
 *
 *   1. Pick the period (defaults to last completed calendar month)
 *   2. Pick which doctor types to include
 *   3. Preview: show willDerive / alreadyDerived / noEligibleVisits buckets
 *   4. Derive — single click runs derivePayoutsBulk for each selected type
 *
 * After completion, the panel shows a results summary and gives the user a
 * direct path to "View N new payouts" or "Mark all paid".
 *
 * This replaces the 30+ round-trips through the old single-doctor Derive
 * dialog for a monthly run.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
  PauseCircle,
} from "lucide-react";
import { API_BASE } from "@/lib/api";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { toast } from "sonner";
import {
  formatRupees,
} from "@/lib/payoutFormatters";
import type {
  PayoutBulkDeriveResult,
  PayoutDerivePreviewResult,
  PayoutDoctorType,
} from "@/types";

export interface PayoutRunCycleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}

interface CyclePeriod {
  year: number;
  month: number; // 0-indexed
}

function lastCompletedMonth(): CyclePeriod {
  const t = new Date();
  // If today is the 1st, the "last completed month" is the month before last;
  // otherwise it's the previous calendar month.
  return {
    year: t.getFullYear(),
    month: t.getMonth() - 1,
  };
}

function periodToISO(p: CyclePeriod): { startDate: string; endDate: string; label: string } {
  const start = new Date(p.year, p.month, 1);
  const end = new Date(p.year, p.month + 1, 0); // last day of month
  return {
    startDate: start.toISOString(),
    endDate: new Date(p.year, p.month + 1, 0, 23, 59, 59, 999).toISOString(),
    label: start.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
  };
}

const DOCTOR_TYPES: { value: PayoutDoctorType; label: string }[] = [
  { value: "REFERRAL", label: "Referral doctors" },
  { value: "CLINIC", label: "Clinic doctors" },
  { value: "DIAGNOSTIC_CENTER", label: "Diagnostic centers" },
];

type Phase = "config" | "preview-loading" | "preview" | "running" | "results";

export function PayoutRunCycle({
  open,
  onOpenChange,
  onCompleted,
}: PayoutRunCycleProps) {
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const navigate = useNavigate();

  const [period, setPeriod] = useState<CyclePeriod>(lastCompletedMonth());
  const [selectedTypes, setSelectedTypes] = useState<Set<PayoutDoctorType>>(
    new Set(["REFERRAL", "CLINIC", "DIAGNOSTIC_CENTER"])
  );
  const [phase, setPhase] = useState<Phase>("config");
  const [preview, setPreview] = useState<Record<PayoutDoctorType, PayoutDerivePreviewResult> | null>(null);
  const [results, setResults] = useState<Record<PayoutDoctorType, PayoutBulkDeriveResult> | null>(null);
  const [expandedBucket, setExpandedBucket] = useState<"will" | "already" | "none" | null>(null);

  useEffect(() => {
    if (open) {
      setPeriod(lastCompletedMonth());
      setSelectedTypes(new Set(["REFERRAL", "CLINIC", "DIAGNOSTIC_CENTER"]));
      setPhase("config");
      setPreview(null);
      setResults(null);
      setExpandedBucket(null);
    }
  }, [open]);

  const periodInfo = useMemo(() => periodToISO(period), [period]);

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": activeBranchId ?? "",
    "Content-Type": "application/json",
  });

  const toggleType = (type: PayoutDoctorType) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const runPreview = async () => {
    if (selectedTypes.size === 0) {
      toast.error("Pick at least one doctor type");
      return;
    }
    setPhase("preview-loading");
    try {
      const accum: Partial<Record<PayoutDoctorType, PayoutDerivePreviewResult>> = {};
      for (const t of selectedTypes) {
        const params = new URLSearchParams();
        params.set("doctorType", t);
        params.set("doctorIds", "all");
        params.set("periodStartDate", periodInfo.startDate);
        params.set("periodEndDate", periodInfo.endDate);
        const res = await fetch(
          `${API_BASE}/payouts/derive/preview?${params.toString()}`,
          { headers: headers() }
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error(body.message ?? `Preview failed for ${t}`);
          setPhase("config");
          return;
        }
        const body = await res.json();
        accum[t] = body.data;
      }
      setPreview(accum as Record<PayoutDoctorType, PayoutDerivePreviewResult>);
      setPhase("preview");
    } catch (err) {
      console.error(err);
      toast.error("Preview failed");
      setPhase("config");
    }
  };

  const runDerive = async () => {
    if (!preview) return;
    setPhase("running");
    const accum: Partial<Record<PayoutDoctorType, PayoutBulkDeriveResult>> = {};
    try {
      for (const t of selectedTypes) {
        const willDerive = preview[t]?.willDerive ?? [];
        if (willDerive.length === 0) continue;
        const res = await fetch(`${API_BASE}/payouts/derive/bulk`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            doctorType: t,
            doctorIds: willDerive.map((d) => d.doctorId),
            periodStartDate: periodInfo.startDate,
            periodEndDate: periodInfo.endDate,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          toast.error(body.message ?? `Derive failed for ${t}`);
          continue;
        }
        const body = await res.json();
        accum[t] = body.data;
      }
      setResults(accum as Record<PayoutDoctorType, PayoutBulkDeriveResult>);
      setPhase("results");
    } catch (err) {
      console.error(err);
      toast.error("Derive failed");
      setPhase("preview");
    }
  };

  const previewLists = useMemo(() => {
    const will: {
      doctorId: string;
      doctorName: string;
      doctorType: PayoutDoctorType;
      amountInPaise: number;
    }[] = [];
    const already: {
      doctorId: string;
      doctorName: string;
      doctorType: PayoutDoctorType;
      payoutId: string;
      amountInPaise: number;
      isPaid: boolean;
    }[] = [];
    const none: { doctorId: string; doctorName: string; doctorType: PayoutDoctorType }[] = [];
    if (!preview) return { will, already, none };
    for (const t of selectedTypes) {
      const p = preview[t];
      if (!p) continue;
      for (const d of p.willDerive) will.push({ ...d, doctorType: t });
      for (const d of p.alreadyDerived) already.push({ ...d, doctorType: t });
      for (const d of p.noEligibleVisits) none.push({ ...d, doctorType: t });
    }
    return { will, already, none };
  }, [preview, selectedTypes]);

  const totals = useMemo(() => {
    const willAmt = previewLists.will.reduce((s, d) => s + d.amountInPaise, 0);
    const alreadyPending = previewLists.already.filter((d) => !d.isPaid);
    const alreadyPaid = previewLists.already.filter((d) => d.isPaid);
    const pendingAmt = alreadyPending.reduce((s, d) => s + d.amountInPaise, 0);
    const paidAmt = alreadyPaid.reduce((s, d) => s + d.amountInPaise, 0);
    return {
      willCount: previewLists.will.length,
      willAmt,
      alreadyCount: previewLists.already.length,
      pendingCount: alreadyPending.length,
      pendingAmt,
      paidCount: alreadyPaid.length,
      paidAmt,
      noneCount: previewLists.none.length,
    };
  }, [previewLists]);

  const totalCounts = {
    will: totals.willCount,
    already: totals.alreadyCount,
    none: totals.noneCount,
  };

  // "View these N in list" — close sheet, navigate to the list filtered to
  // this period (custom preset) so the owner can act on the rows directly.
  const viewAlreadyDerivedInList = () => {
    const start = new Date(period.year, period.month, 1);
    const end = new Date(period.year, period.month + 1, 0);
    const ymd = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    // No status filter — show pending AND paid for the period so the user
    // sees the full picture and can choose what to do next.
    const params = new URLSearchParams({
      tab: "by-period",
      preset: "custom",
      startDate: ymd(start),
      endDate: ymd(end),
    });
    onOpenChange(false);
    navigate(`/owner/payouts?${params.toString()}`);
  };

  const totalDerived = useMemo(() => {
    if (!results) return { count: 0, amountInPaise: 0 };
    let count = 0;
    let amount = 0;
    for (const t of selectedTypes) {
      const r = results[t];
      if (!r) continue;
      count += r.derived.length;
      for (const p of r.derived) amount += p.derivedAmountInPaise;
    }
    return { count, amountInPaise: amount };
  }, [results, selectedTypes]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Run Monthly Cycle</SheetTitle>
          <SheetDescription>
            Derive payouts for every active doctor in the selected period.
            Review the preview before committing.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 py-6">
          {/* Step 1: period */}
          <section>
            <Label className="text-sm font-medium">1. Period</Label>
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  setPeriod((p) =>
                    p.month === 0
                      ? { year: p.year - 1, month: 11 }
                      : { ...p, month: p.month - 1 }
                  )
                }
                disabled={phase === "running" || phase === "preview-loading"}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="px-4 py-1.5 rounded-md border bg-muted/40 text-sm font-medium min-w-[12rem] text-center">
                {periodInfo.label}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() =>
                  setPeriod((p) =>
                    p.month === 11
                      ? { year: p.year + 1, month: 0 }
                      : { ...p, month: p.month + 1 }
                  )
                }
                disabled={phase === "running" || phase === "preview-loading"}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <span className="text-xs text-muted-foreground ml-2">
                Defaults to last completed month
              </span>
            </div>
          </section>

          {/* Step 2: doctor types */}
          <section>
            <Label className="text-sm font-medium">2. Who to include</Label>
            <div className="mt-2 space-y-2">
              {DOCTOR_TYPES.map((t) => (
                <label
                  key={t.value}
                  className="flex items-center gap-2 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedTypes.has(t.value)}
                    onCheckedChange={() => toggleType(t.value)}
                    disabled={phase !== "config" && phase !== "preview"}
                  />
                  <span className="text-sm">{t.label}</span>
                </label>
              ))}
            </div>
          </section>

          {/* Step 3: preview / progress */}
          {phase === "config" && (
            <Button onClick={runPreview} disabled={selectedTypes.size === 0}>
              Preview
            </Button>
          )}

          {phase === "preview-loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Building preview…
            </div>
          )}

          {phase === "preview" && preview && (
            <section className="space-y-3">
              <Label className="text-sm font-medium">3. Preview</Label>
              <div className="rounded-lg border divide-y">
                <PreviewBucket
                  icon={<CheckCircle2 className="h-4 w-4 text-green-600" />}
                  label="Will derive"
                  count={totalCounts.will}
                  amountInPaise={totals.willAmt}
                  description="No existing payout for this period"
                  doctors={previewLists.will}
                  expanded={expandedBucket === "will"}
                  onToggleExpand={() =>
                    setExpandedBucket(expandedBucket === "will" ? null : "will")
                  }
                />
                <PreviewBucket
                  icon={<PauseCircle className="h-4 w-4 text-yellow-600" />}
                  label="Already derived"
                  count={totalCounts.already}
                  amountInPaise={totals.pendingAmt + totals.paidAmt}
                  description={
                    totals.alreadyCount === 0
                      ? "Existing rows — derive won't re-create them"
                      : `${totals.pendingCount} pending · ${totals.paidCount} paid`
                  }
                  doctors={previewLists.already}
                  expanded={expandedBucket === "already"}
                  onToggleExpand={() =>
                    setExpandedBucket(
                      expandedBucket === "already" ? null : "already"
                    )
                  }
                />
                <PreviewBucket
                  icon={<AlertCircle className="h-4 w-4 text-muted-foreground" />}
                  label="No eligible visits"
                  count={totalCounts.none}
                  description="No finalized work in this period — skipped"
                  doctors={previewLists.none}
                  expanded={expandedBucket === "none"}
                  onToggleExpand={() =>
                    setExpandedBucket(expandedBucket === "none" ? null : "none")
                  }
                />
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                {totalCounts.will > 0 && (
                  <Button
                    onClick={runDerive}
                    disabled={phase === "running"}
                  >
                    {phase === "running"
                      ? `Deriving ${totalCounts.will}...`
                      : `Derive ${totalCounts.will} ${totalCounts.will === 1 ? "payout" : "payouts"} · ${formatRupees(totals.willAmt)}`}
                  </Button>
                )}
                {/* Most useful next step when you've already derived but not paid */}
                {totals.pendingCount > 0 && (
                  <Button
                    variant={totalCounts.will === 0 ? "default" : "outline"}
                    onClick={viewAlreadyDerivedInList}
                  >
                    View {totals.pendingCount} pending ·{" "}
                    {formatRupees(totals.pendingAmt)}
                  </Button>
                )}
                {totalCounts.already > 0 && totals.pendingCount === 0 && (
                  <Button variant="outline" onClick={viewAlreadyDerivedInList}>
                    View {totalCounts.already} in list
                  </Button>
                )}
                <Button variant="outline" onClick={() => setPhase("config")}>
                  Back
                </Button>
              </div>

              {totalCounts.will === 0 && totalCounts.already === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nothing to do for this period — no doctors had eligible
                  finalized visits.
                </p>
              )}
            </section>
          )}

          {phase === "running" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Deriving payouts…
            </div>
          )}

          {phase === "results" && results && (
            <section className="space-y-3">
              <Label className="text-sm font-medium">Results</Label>
              <div className="rounded-lg border bg-green-50 p-4 text-sm">
                <div className="flex items-center gap-2 text-green-800">
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="font-medium">
                    Derived {totalDerived.count}{" "}
                    {totalDerived.count === 1 ? "payout" : "payouts"} totalling{" "}
                    {formatRupees(totalDerived.amountInPaise)}
                  </span>
                </div>
              </div>

              {/* Per-type breakdown */}
              <div className="space-y-2">
                {Array.from(selectedTypes).map((t) => {
                  const r = results[t];
                  if (!r) return null;
                  return (
                    <div key={t} className="text-sm border rounded-md p-3">
                      <div className="font-medium">
                        {DOCTOR_TYPES.find((x) => x.value === t)?.label}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {r.derived.length} new · {r.alreadyExisted.length} existing
                        {r.skipped.length > 0 ? ` · ${r.skipped.length} skipped` : ""}
                      </div>
                      {r.skipped.length > 0 && (
                        <ul className="mt-2 text-xs text-muted-foreground list-disc pl-5 space-y-0.5">
                          {r.skipped.slice(0, 5).map((s) => (
                            <li key={s.doctorId}>
                              {s.doctorName} — {s.reason}
                            </li>
                          ))}
                          {r.skipped.length > 5 && (
                            <li>+ {r.skipped.length - 5} more</li>
                          )}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <SheetFooter>
          {phase === "results" ? (
            <Button onClick={onCompleted}>Done</Button>
          ) : (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

type BucketDoctor = {
  doctorId: string;
  doctorName: string;
  doctorType: PayoutDoctorType;
  amountInPaise?: number;
  isPaid?: boolean;
};

function PreviewBucket(props: {
  icon: React.ReactNode;
  label: string;
  count: number;
  amountInPaise?: number;
  description: string;
  doctors: BucketDoctor[];
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const canExpand = props.count > 0;
  return (
    <div>
      <button
        type="button"
        onClick={canExpand ? props.onToggleExpand : undefined}
        className={`w-full flex items-center gap-3 p-3 text-left ${
          canExpand ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
        disabled={!canExpand}
      >
        {props.icon}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{props.label}</div>
          <div className="text-xs text-muted-foreground truncate">{props.description}</div>
        </div>
        <div className="flex flex-col items-end shrink-0">
          <div className="text-2xl font-semibold tabular-nums leading-none">
            {props.count}
          </div>
          {props.amountInPaise !== undefined && props.amountInPaise > 0 && (
            <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
              {formatRupees(props.amountInPaise)}
            </div>
          )}
        </div>
        {canExpand &&
          (props.expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ))}
      </button>
      {props.expanded && props.doctors.length > 0 && (
        <ul className="px-3 pb-3 space-y-1 text-sm bg-muted/30">
          {props.doctors.map((d) => (
            <li
              key={`${d.doctorType}:${d.doctorId}`}
              className="flex items-center gap-2 py-1"
            >
              <span className="text-xs font-mono text-muted-foreground w-14 shrink-0">
                {d.doctorType === "REFERRAL"
                  ? "REF"
                  : d.doctorType === "CLINIC"
                    ? "CLINIC"
                    : "DC"}
              </span>
              <span className="truncate flex-1">{d.doctorName}</span>
              {d.amountInPaise !== undefined && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatRupees(d.amountInPaise)}
                </span>
              )}
              {d.isPaid !== undefined && (
                <span
                  className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                    d.isPaid
                      ? "bg-green-100 text-green-700"
                      : "bg-yellow-100 text-yellow-700"
                  }`}
                >
                  {d.isPaid ? "Paid" : "Pending"}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

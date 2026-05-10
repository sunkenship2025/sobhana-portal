/**
 * "By Doctor" pivot tab.
 *
 * One row per doctor with totals + last-paid date for the active period
 * window. Click a row to filter the By Period tab to that doctor.
 *
 * Filters are passed in from the parent so the period and doctor-type chips
 * stay consistent across tabs.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import {
  formatRupees,
  formatDate,
  formatDoctorTypeShort,
} from "@/lib/payoutFormatters";
import { toast } from "sonner";
import type { DoctorPayoutRollup, PayoutDoctorType } from "@/types";

export interface PayoutsByDoctorProps {
  filters: {
    doctorType: PayoutDoctorType | "all";
    startDate: string;
    endDate: string;
    q: string;
  };
  isOwner: boolean;
  onOpenDoctor: (doctorId: string, doctorType: PayoutDoctorType) => void;
  refreshKey?: number; // bump to force re-fetch after mutations elsewhere
}

export function PayoutsByDoctor({
  filters,
  onOpenDoctor,
  refreshKey,
}: PayoutsByDoctorProps) {
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();
  const [rows, setRows] = useState<DoctorPayoutRollup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !activeBranchId) return;
    let abort = false;
    setLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (filters.doctorType !== "all") params.set("doctorType", filters.doctorType);
        if (filters.startDate) params.set("startDate", filters.startDate);
        if (filters.endDate) params.set("endDate", filters.endDate + "T23:59:59.999Z");
        if (filters.q) params.set("q", filters.q);
        const res = await fetch(
          `${API_BASE}/payouts/summary-by-doctor?${params.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranchId,
            },
          }
        );
        if (!res.ok) {
          toast.error("Failed to load doctor summary");
          return;
        }
        const body = await res.json();
        if (!abort) setRows(body.data ?? []);
      } finally {
        if (!abort) setLoading(false);
      }
    })();
    return () => {
      abort = true;
    };
  }, [
    token,
    activeBranchId,
    filters.doctorType,
    filters.startDate,
    filters.endDate,
    filters.q,
    refreshKey,
  ]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.pending += r.pendingTotalInPaise;
        acc.paid += r.paidTotalInPaise;
        acc.periods += r.periodCount;
        return acc;
      },
      { pending: 0, paid: 0, periods: 0 }
    );
  }, [rows]);

  return (
    <Card>
      <CardContent className="pt-6">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground">No doctors with payouts in this period.</p>
          </div>
        ) : (
          <>
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead>Doctor</TableHead>
                  <TableHead className="w-24">Type</TableHead>
                  <TableHead className="text-right">Periods</TableHead>
                  <TableHead className="text-right">Pending Total</TableHead>
                  <TableHead className="text-right">Paid Total</TableHead>
                  <TableHead>Last Paid</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={`${r.doctorType}:${r.doctorId}`}
                    className="cursor-pointer"
                    onClick={() => onOpenDoctor(r.doctorId, r.doctorType)}
                  >
                    <TableCell className="font-medium">{r.doctorName}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.doctorType === "REFERRAL"
                            ? "default"
                            : r.doctorType === "CLINIC"
                              ? "secondary"
                              : "outline"
                        }
                        title={
                          r.doctorType === "DIAGNOSTIC_CENTER"
                            ? "Diagnostic Center"
                            : undefined
                        }
                      >
                        {formatDoctorTypeShort(r.doctorType)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.periodCount}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      {r.pendingTotalInPaise > 0
                        ? formatRupees(r.pendingTotalInPaise)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.paidTotalInPaise > 0
                        ? formatRupees(r.paidTotalInPaise)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(r.lastPaidAt)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" aria-label="Open doctor's payouts">
                        <ArrowRight className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Footer totals */}
            <div className="flex justify-end mt-4 pt-4 border-t">
              <div className="text-right text-sm space-y-1">
                <div className="text-muted-foreground">
                  {rows.length} doctors · {totals.periods} periods
                </div>
                <div>
                  <span className="text-muted-foreground mr-2">Pending</span>
                  <span className="font-semibold">{formatRupees(totals.pending)}</span>
                  <span className="mx-3 text-muted-foreground">|</span>
                  <span className="text-muted-foreground mr-2">Paid</span>
                  <span className="font-semibold">{formatRupees(totals.paid)}</span>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// Loader-only sentinel (for Suspense boundaries elsewhere — currently unused).
export function PayoutsByDoctorFallback() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

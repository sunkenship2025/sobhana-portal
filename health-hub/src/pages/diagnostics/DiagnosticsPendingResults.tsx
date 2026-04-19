import { useState, useMemo, useEffect } from "react";
import { API_BASE } from "@/lib/api";
import { useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranchStore } from "@/store/branchStore";
import { useAuthStore } from "@/store/authStore";
import { StatusBadge } from "@/components/ui/status-badge";
import { toast } from "sonner";
import { Clock, Search, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

type PaymentType = "CASH" | "ONLINE" | "CHEQUE";

const matchesDateFilter = (filter: string, value: string) => {
  if (filter === "all") return true;

  const visitDate = new Date(value);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  if (filter === "today") {
    return visitDate >= todayStart && visitDate < tomorrowStart;
  }

  if (filter === "yesterday") {
    return visitDate >= yesterdayStart && visitDate < todayStart;
  }

  if (filter === "week") {
    return visitDate >= weekStart && visitDate < tomorrowStart;
  }

  return true;
};

const DiagnosticsPendingResults = () => {
  const navigate = useNavigate();
  const { activeBranchId } = useBranchStore();
  const { token } = useAuthStore();
  const [dateFilter, setDateFilter] = useState("today");
  const [search, setSearch] = useState("");
  const [pendingVisits, setPendingVisits] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [dueVisit, setDueVisit] = useState<any | null>(null);
  const [collectAmount, setCollectAmount] = useState("");
  const [collectPaymentType, setCollectPaymentType] =
    useState<PaymentType>("CASH");
  const [collectingDue, setCollectingDue] = useState(false);
  const [collectSuccessId, setCollectSuccessId] = useState<string | null>(null);

  const formatMoneyFromPaise = (amountInPaise?: number | null) =>
    `₹${((amountInPaise ?? 0) / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  // Fetch pending visits from API (DRAFT and WAITING status)
  useEffect(() => {
    const fetchPendingVisits = async () => {
      try {
        setLoading(true);
        // Fetch DRAFT visits (no results entered yet) and WAITING visits (results saved but not finalized)
        const [draftRes, waitingRes] = await Promise.all([
          fetch(`${API_BASE}/visits/diagnostic?status=DRAFT`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranchId,
            },
          }),
          fetch(`${API_BASE}/visits/diagnostic?status=WAITING`, {
            headers: {
              Authorization: `Bearer ${token}`,
              "X-Branch-Id": activeBranchId,
            },
          }),
        ]);

        const draftData = draftRes.ok ? await draftRes.json() : [];
        const waitingData = waitingRes.ok ? await waitingRes.json() : [];

        // Combine and sort by createdAt
        const combined = [...draftData, ...waitingData].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        setPendingVisits(combined);
      } catch (error) {
        console.error("Failed to fetch pending visits:", error);
      } finally {
        setLoading(false);
      }
    };

    if (token && activeBranchId) {
      fetchPendingVisits();
    }
  }, [token, activeBranchId]);

  // Build view data from API response
  const visitsWithDetails = useMemo(() => {
    return pendingVisits
      .filter((visit) => visit.branchId === activeBranchId) // Branch-scoped
      .map((visit) => ({
        visit,
        patient: visit.patient, // API response includes patient data
        testOrders: visit.testOrders || [], // API response includes test orders
      }));
  }, [pendingVisits, activeBranchId]);

  const filteredVisits = useMemo(() => {
    return visitsWithDetails.filter(({ patient, visit }) => {
      if (!visit.hasReportableOrders || visit.nextAction !== "ENTER_RESULTS") {
        return false;
      }

      if (!matchesDateFilter(dateFilter, visit.createdAt)) {
        return false;
      }

      if (!search) return true;
      const searchLower = search.toLowerCase();
      const phone =
        patient?.identifiers?.find((id: any) => id.type === "PHONE")?.value ||
        "";
      return (
        phone.includes(search) ||
        patient?.name.toLowerCase().includes(searchLower) ||
        visit.billNumber.toLowerCase().includes(searchLower)
      );
    });
  }, [visitsWithDetails, dateFilter, search]);

  const handleAction = (visit: any) => {
    navigate(`/diagnostics/results/${visit.id}`);
  };

  const openCollectDue = (visit: any) => {
    setDueVisit(visit);
    setCollectAmount(
      visit.dueAmountInPaise ? String(visit.dueAmountInPaise / 100) : "",
    );
    setCollectPaymentType(visit.paymentType || "CASH");
  };

  const handleCollectDue = async () => {
    if (!dueVisit) return;

    const amount = Number(collectAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid collection amount");
      return;
    }

    setCollectingDue(true);
    try {
      const response = await fetch(
        `${API_BASE}/visits/diagnostic/${dueVisit.id}/collect-due`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Branch-Id": activeBranchId,
          },
          body: JSON.stringify({
            amount,
            paymentType: collectPaymentType,
          }),
        },
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to collect due");
      }

      setPendingVisits((prev) =>
        prev.map((visit) =>
          visit.id === dueVisit.id
            ? {
                ...visit,
                paymentType: data.paymentType,
                paymentStatus: data.paymentStatus,
                discountType: data.discountType,
                discountPercentage: data.discountPercentage,
                discountAmountInPaise: data.discountAmountInPaise,
                paidAmountInPaise: data.paidAmountInPaise,
                netAmountInPaise: data.netAmountInPaise,
                dueAmountInPaise: data.dueAmountInPaise,
              }
            : visit,
        ),
      );
      toast.success("Due payment collected");
      setCollectSuccessId(dueVisit.id);
    } catch (error: any) {
      toast.error(error.message || "Failed to collect due");
    } finally {
      setCollectingDue(false);
    }
  };

  if (loading) {
    return (
      <AppLayout context="diagnostics">
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout context="diagnostics">
      <div className="space-y-6 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold">Pending Results</h1>
          <p className="text-muted-foreground">
            Which lab cases still need results entered?
          </p>
        </div>

        {/* Filters */}
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <div className="space-y-2">
                <Label>Date</Label>
                <Select value={dateFilter} onValueChange={setDateFilter}>
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="yesterday">Yesterday</SelectItem>
                    <SelectItem value="week">This Week</SelectItem>
                    <SelectItem value="all">All Time</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 w-full flex-1 sm:max-w-sm">
                <Label>Search</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Phone / Bill Number"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-9"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Result Queue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-warning" />
              Result Queue ({filteredVisits.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {filteredVisits.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No pending results found.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredVisits.map(({ visit, patient, testOrders }) => (
                  <div
                    key={visit.id}
                    className="flex flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">
                          {patient?.name || "Unknown"}
                        </span>
                        <span className="text-muted-foreground">
                          | {patient?.age} | {patient?.gender}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <span className="text-muted-foreground">
                          Bill #:{" "}
                          <span className="font-mono">{visit.billNumber}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Tests:{" "}
                          {testOrders
                            .filter(
                              (testOrder) =>
                                testOrder.workflowMode !== "BILL_ONLY",
                            )
                            .map((testOrder) => testOrder.testCode)
                            .join(", ")}
                        </span>
                        {visit.hasBillOnlyOrders &&
                          visit.hasReportableOrders && (
                            <span className="text-amber-700">
                              Includes bill-only items
                            </span>
                          )}
                        {(visit.dueAmountInPaise ?? 0) > 0 && (
                          <span className="font-medium text-amber-700">
                            Due: {formatMoneyFromPaise(visit.dueAmountInPaise)}
                          </span>
                        )}
                      </div>
                      <StatusBadge status={visit.status} />
                    </div>
                    <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
                      {(visit.dueAmountInPaise ?? 0) > 0 && (
                        <Button
                          className="w-full sm:w-auto"
                          variant="outline"
                          onClick={() => openCollectDue(visit)}
                        >
                          Collect Due
                        </Button>
                      )}
                      <Button
                        className="w-full sm:w-auto"
                        onClick={() => handleAction(visit)}
                      >
                        Enter Results
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={Boolean(dueVisit)}
          onOpenChange={(open) => {
            if (!open) {
              setDueVisit(null);
              setCollectSuccessId(null);
              setCollectAmount("");
            }
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {collectSuccessId ? "Payment Collected" : "Collect Due"}
              </DialogTitle>
            </DialogHeader>
            {dueVisit && !collectSuccessId && (
              <div className="space-y-4">
                <div className="rounded-lg border bg-muted/30 p-3 text-sm space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span>
                      {formatMoneyFromPaise(
                        Math.round((dueVisit.totalAmount ?? 0) * 100),
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Discount</span>
                    <span>
                      -{formatMoneyFromPaise(dueVisit.discountAmountInPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between font-medium">
                    <span>Net</span>
                    <span>
                      {formatMoneyFromPaise(dueVisit.netAmountInPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Already Paid</span>
                    <span>
                      {formatMoneyFromPaise(dueVisit.paidAmountInPaise)}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold text-amber-700">
                    <span>Due</span>
                    <span>
                      {formatMoneyFromPaise(dueVisit.dueAmountInPaise)}
                    </span>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Collect Now (₹)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={(dueVisit.dueAmountInPaise ?? 0) / 100}
                    step="1"
                    value={collectAmount}
                    onChange={(e) => setCollectAmount(e.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Payment Type</Label>
                  <Select
                    value={collectPaymentType}
                    onValueChange={(value) =>
                      setCollectPaymentType(value as PaymentType)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="CASH">Cash</SelectItem>
                      <SelectItem value="ONLINE">Online</SelectItem>
                      <SelectItem value="CHEQUE">Cheque</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {dueVisit && collectSuccessId && (
              <div className="space-y-4 py-4 text-center">
                <div className="text-muted-foreground mb-4">
                  Payment recorded successfully. You can now print the updated
                  bill.
                </div>
                <Button
                  className="w-full"
                  onClick={() =>
                    window.open(
                      `/bill/print/diagnostics/${collectSuccessId}`,
                      "_blank",
                    )
                  }
                >
                  Print Updated Bill
                </Button>
              </div>
            )}
            <DialogFooter>
              {!collectSuccessId ? (
                <>
                  <Button variant="outline" onClick={() => setDueVisit(null)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCollectDue}
                    disabled={collectingDue || !collectAmount}
                  >
                    {collectingDue ? "Collecting..." : "Collect Payment"}
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => {
                    setDueVisit(null);
                    setCollectSuccessId(null);
                    setCollectAmount("");
                  }}
                >
                  Close
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
};

export default DiagnosticsPendingResults;

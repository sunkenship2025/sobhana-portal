import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { API_BASE, API_BASE_URL } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Printer, Download } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { formatRupees } from "@/lib/payoutFormatters";
import {
  OwnerPageHeader,
  SectionCard,
  TOKENS,
  FullPageSkeleton,
  ErrorCard,
  formatIstDate,
} from "./_shared/ownerUi";
import { PayoutMarkPaidDialog } from "@/components/payouts/PayoutMarkPaidDialog";
import type { PayoutStatement as Statement, PayoutSummary, PaymentType } from "@/types";

const LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

function docTitle(s: Statement): string {
  if (s.isLab) return s.status === "PAID" ? "OUTSIDE LAB — PAYMENT VOUCHER" : "OUTSIDE LAB PAYABLE";
  return s.status === "PAID" ? "PAYOUT RECEIPT" : "PAYOUT STATEMENT";
}

export default function PayoutStatement() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { token } = useAuthStore();
  const { activeBranchId } = useBranchStore();

  const [stmt, setStmt] = useState<Statement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const headers = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "X-Branch-Id": activeBranchId ?? "",
    "Content-Type": "application/json",
  });

  const fetchStatement = async () => {
    if (!token || !activeBranchId || !id) return;
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}/statement`, { headers: headers() });
      if (!res.ok) {
        setError(true);
        return;
      }
      setStmt(((await res.json()).data ?? null) as Statement);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatement();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeBranchId, id]);

  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [markPaidBusy, setMarkPaidBusy] = useState(false);

  const submitMarkPaid = async (payment: {
    paymentMethod: PaymentType;
    paymentReferenceId?: string;
    notes?: string;
  }) => {
    if (!id) return;
    setMarkPaidBusy(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}/mark-paid`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payment),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.message ?? "Failed to mark paid");
      } else {
        toast.success("Marked as paid");
        setMarkPaidOpen(false);
        await fetchStatement();
      }
    } finally {
      setMarkPaidBusy(false);
    }
  };

  const exportExcel = async () => {
    if (!id || !token || !activeBranchId) return;
    const res = await fetch(`${API_BASE}/payouts/${id}/export`, {
      headers: { Authorization: `Bearer ${token}`, "X-Branch-Id": activeBranchId },
    });
    if (!res.ok) {
      toast.error("Failed to export");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${stmt?.payeeName.replace(/\s+/g, "_") ?? "payout"}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const period = stmt
    ? `${formatIstDate(stmt.periodStartDate)} – ${formatIstDate(stmt.periodEndDate)}`
    : "";
  const isLab = stmt?.isLab ?? false;
  const accent = isLab ? TOKENS.caution : TOKENS.textPrimary;

  return (
    <AppLayout context="owner" subContext="payouts">
      <div style={{ maxWidth: 980 }} className="pb-16">
        <div className="print:hidden">
          <OwnerPageHeader
            title={stmt ? `${stmt.payeeName} — ${isLab ? "Lab payable" : "Statement"}` : "Statement"}
            subtitle={
              <button
                onClick={() => navigate("/owner/payouts")}
                className="inline-flex items-center"
                style={{ color: TOKENS.info }}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Back to Pay-Run
              </button>
            }
            rightSlot={
              <>
                <Button variant="outline" size="sm" onClick={() => window.print()}>
                  <Printer className="mr-1.5 h-4 w-4" /> Print
                </Button>
                <Button variant="outline" size="sm" onClick={exportExcel}>
                  <Download className="mr-1.5 h-4 w-4" /> Excel
                </Button>
                {stmt && stmt.status === "PENDING" && (
                  <Button size="sm" onClick={() => setMarkPaidOpen(true)}>
                    Mark Paid
                  </Button>
                )}
              </>
            }
          />
        </div>

        {loading ? (
          <FullPageSkeleton rows={3} />
        ) : error || !stmt ? (
          <ErrorCard onRetry={fetchStatement} />
        ) : (
          <div className="space-y-4">
            {/* Print-only letterhead */}
            <div className="hidden print:block" style={{ textAlign: "center", marginBottom: 12 }}>
              <img src={LOGO_URL} alt="Sobhana" style={{ height: 48, margin: "0 auto" }} />
              <div style={{ fontWeight: 700, letterSpacing: "0.12em", marginTop: 8, fontSize: 13 }}>
                {docTitle(stmt)}
              </div>
            </div>

            {/* Header card */}
            <SectionCard>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{stmt.payeeName}</div>
                  <div style={{ fontSize: 12, color: TOKENS.textTertiary, marginTop: 2 }}>
                    Period {period} · Branch {stmt.branchName || "—"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div
                    style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: accent }}
                  >
                    {isLab ? "Payable" : "Total payout"}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 600, color: accent }}>
                    {formatRupees(stmt.grandTotal.finAmtInPaise)}
                  </div>
                </div>
              </div>
              <div
                className="mt-3 border-t pt-3"
                style={{ borderColor: TOKENS.border, fontSize: 13 }}
              >
                <span style={{ color: TOKENS.textSecondary }}>Status: </span>
                <span
                  className="font-medium"
                  style={{ color: stmt.status === "PAID" ? TOKENS.healthy : TOKENS.caution }}
                >
                  {stmt.status === "PAID" ? "Paid" : isLab ? "Unpaid" : "Pending"}
                </span>
                {stmt.status === "PAID" && (
                  <span style={{ color: TOKENS.textTertiary, marginLeft: 8 }}>
                    {stmt.paidAt ? formatIstDate(stmt.paidAt) : ""}
                    {stmt.paymentMethod ? ` · ${stmt.paymentMethod}` : ""}
                    {stmt.paymentReferenceId ? ` · ref ${stmt.paymentReferenceId}` : ""}
                    {stmt.notes ? ` · ${stmt.notes}` : ""}
                  </span>
                )}
              </div>
            </SectionCard>

            {/* Category bands */}
            {stmt.bands.map((band) => (
              <SectionCard key={band.category} padding={0}>
                <div
                  className="flex items-center justify-between px-3 py-2"
                  style={{ background: "#f6f5f2", borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
                >
                  <span className="font-medium" style={{ fontSize: 12 }}>
                    {band.label}
                  </span>
                  <span style={{ fontSize: 12, color: TOKENS.textSecondary }}>
                    {formatRupees(band.subtotal.finAmtInPaise)}
                  </span>
                </div>
                <table className="w-full" style={{ fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: TOKENS.textTertiary, textAlign: "left" }}>
                      <th className="py-1.5 pl-3 font-normal">Date</th>
                      <th className="py-1.5 font-normal">Bill #</th>
                      <th className="py-1.5 font-normal">Patient</th>
                      <th className="py-1.5 font-normal">Test / fee</th>
                      <th className="py-1.5 font-normal">Basis</th>
                      <th className="py-1.5 text-right font-normal">T Amt</th>
                      <th className="py-1.5 text-right font-normal">Disc</th>
                      <th className="py-1.5 text-right font-normal">P Amt</th>
                      <th className="py-1.5 text-right font-normal">{isLab ? "Payable" : "Fin Amt"}</th>
                      {isLab && <th className="py-1.5 pr-3 text-right font-normal">Margin</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {band.rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                        <td className="py-1.5 pl-3" style={{ color: TOKENS.textTertiary }}>
                          {formatIstDate(r.date)}
                        </td>
                        <td className="py-1.5" style={{ color: TOKENS.textTertiary }}>{r.billNumber}</td>
                        <td className="py-1.5">
                          {r.patientTitle ? `${r.patientTitle} ` : ""}
                          {r.patientName}
                        </td>
                        <td className="py-1.5">{r.testOrFee}</td>
                        <td className="py-1.5" style={{ color: TOKENS.textTertiary }}>{r.basisLabel}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatRupees(r.tAmtInPaise)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatRupees(r.discInPaise)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatRupees(r.pAmtInPaise)}</td>
                        <td className="py-1.5 text-right font-medium tabular-nums">
                          {formatRupees(r.finAmtInPaise)}
                        </td>
                        {isLab && (
                          <td
                            className="py-1.5 pr-3 text-right tabular-nums"
                            style={{
                              color:
                                (r.centerMarginInPaise ?? 0) < 0 ? TOKENS.critical : TOKENS.textSecondary,
                            }}
                          >
                            {formatRupees(r.centerMarginInPaise ?? 0)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </SectionCard>
            ))}

            {/* Grand total */}
            <div
              className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl px-4 py-3"
              style={{ background: TOKENS.textPrimary, color: "white", fontSize: 13 }}
            >
              <span className="font-medium">GRAND TOTAL</span>
              <span style={{ color: "#bdbbb3" }}>|</span>
              <span>T Amt <b>{formatRupees(stmt.grandTotal.tAmtInPaise)}</b></span>
              <span>Disc <b>{formatRupees(stmt.grandTotal.discInPaise)}</b></span>
              <span>P Amt <b>{formatRupees(stmt.grandTotal.pAmtInPaise)}</b></span>
              <span className="ml-auto" style={{ fontSize: 15 }}>
                {isLab ? "Payable" : "Fin"} <b>{formatRupees(stmt.grandTotal.finAmtInPaise)}</b>
              </span>
            </div>

            {/* Lab margin */}
            {isLab && stmt.lab && (
              <SectionCard label="Centre margin on these tests">
                <div style={{ fontSize: 13 }}>
                  Patient price <b>{formatRupees(stmt.lab.billedToPatientInPaise)}</b> − lab cost{" "}
                  <b>{formatRupees(stmt.lab.vendorCostInPaise)}</b> = margin{" "}
                  <b
                    style={{
                      color: stmt.lab.marginInPaise < 0 ? TOKENS.critical : TOKENS.healthy,
                    }}
                  >
                    {formatRupees(stmt.lab.marginInPaise)}
                  </b>{" "}
                  <span style={{ color: TOKENS.textTertiary }}>({stmt.lab.marginPct}%)</span>
                </div>
              </SectionCard>
            )}
          </div>
        )}
      </div>

      {stmt && (
        <PayoutMarkPaidDialog
          open={markPaidOpen}
          onOpenChange={setMarkPaidOpen}
          busy={markPaidBusy}
          payout={
            {
              id: stmt.id,
              doctorType: stmt.payeeType,
              doctorId: stmt.payeeId,
              doctorName: stmt.payeeName,
              branchId: activeBranchId ?? "",
              branchName: stmt.branchName,
              periodStartDate: stmt.periodStartDate,
              periodEndDate: stmt.periodEndDate,
              derivedAmountInPaise: stmt.grandTotal.finAmtInPaise,
              derivedAt: "",
              paidAt: stmt.paidAt,
              paymentMethod: stmt.paymentMethod,
            } as PayoutSummary
          }
          bulkCount={0}
          bulkTotalInPaise={0}
          onConfirm={submitMarkPaid}
        />
      )}
    </AppLayout>
  );
}

import { useEffect, useState, Fragment, type CSSProperties } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { API_BASE, API_BASE_URL } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronDown, Printer, Download, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@/store/authStore";
import { useBranchStore } from "@/store/branchStore";
import { formatRupees } from "@/lib/payoutFormatters";
import {
  OwnerPageHeader,
  SectionCard,
  MiniBar,
  TOKENS,
  FullPageSkeleton,
  ErrorCard,
  formatIstDate,
} from "./_shared/ownerUi";
import {
  PayoutMarkPaidDialog,
  type PayoutMarkPaidPayment,
} from "@/components/payouts/PayoutMarkPaidDialog";
import type {
  PayoutStatement as Statement,
  StatementBand,
  PayoutCategory,
  PayoutSummary,
  PaymentType,
} from "@/types";

const CAT_COLOR: Record<PayoutCategory, string> = {
  LAB: "#8a93a3",
  XRAY: "#a8896f",
  USG: "#6f86a8",
  ECG: "#9a9a6f",
  SPL: "#888780",
};

// Group statement line items by bill/patient (for the per-patient rows + chips).
function groupRowsByBill(bands: StatementBand[]) {
  const map = new Map<
    string,
    {
      key: string;
      billNumber: string;
      patient: string;
      date: string;
      tAmt: number;
      disc: number;
      pAmt: number;
      fin: number;
      items: { testOrFee: string; category: PayoutCategory; basisLabel: string }[];
    }
  >();
  for (const band of bands) {
    for (const r of band.rows) {
      const key = `${r.billNumber}|${r.patientName}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          billNumber: r.billNumber,
          patient: `${r.patientTitle ? r.patientTitle + " " : ""}${r.patientName}`,
          date: r.date,
          tAmt: 0,
          disc: 0,
          pAmt: 0,
          fin: 0,
          items: [],
        };
        map.set(key, g);
      }
      g.tAmt += r.tAmtInPaise;
      g.disc += r.discInPaise;
      g.pAmt += r.pAmtInPaise;
      g.fin += r.finAmtInPaise;
      g.items.push({ testOrFee: r.testOrFee, category: r.category, basisLabel: r.basisLabel });
      if (new Date(r.date) < new Date(g.date)) g.date = r.date;
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

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
  const [sendingWa, setSendingWa] = useState(false);

  const sendWhatsApp = async () => {
    if (!id) return;
    setSendingWa(true);
    try {
      const res = await fetch(`${API_BASE}/payouts/${id}/send-statement`, {
        method: "POST",
        headers: headers(),
      });
      const body = await res.json();
      if (!res.ok) {
        toast.error(body.message ?? "Failed to send on WhatsApp");
      } else {
        toast.success("Statement sent on WhatsApp");
      }
    } catch {
      toast.error("Failed to send on WhatsApp");
    } finally {
      setSendingWa(false);
    }
  };

  const [catOpen, setCatOpen] = useState(true);

  const submitMarkPaid = async (payment: PayoutMarkPaidPayment) => {
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
                <Button variant="outline" size="sm" onClick={sendWhatsApp} disabled={sendingWa}>
                  <MessageCircle className="mr-1.5 h-4 w-4" /> {sendingWa ? "Sending…" : "WhatsApp"}
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
          <>
          <div className="space-y-4 print:hidden">
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

            {/* Category breakdown band */}
            {stmt.bands.length > 0 && (
              <SectionCard>
                <button className="mb-2 flex w-full items-center gap-2" onClick={() => setCatOpen((o) => !o)}>
                  <ChevronDown
                    className="h-4 w-4"
                    style={{ transform: catOpen ? "none" : "rotate(-90deg)", color: TOKENS.textTertiary }}
                  />
                  <span
                    className="font-medium uppercase"
                    style={{ fontSize: 11, letterSpacing: "0.06em", color: TOKENS.textSecondary }}
                  >
                    Category breakdown
                  </span>
                </button>
                {catOpen && (
                  <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-5">
                    {stmt.bands.map((band) => {
                      const max = Math.max(...stmt.bands.map((b) => b.subtotal.finAmtInPaise), 1);
                      return (
                        <div key={band.category}>
                          <div style={{ fontSize: 11, color: TOKENS.textSecondary }}>{band.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 600, margin: "2px 0 5px" }}>
                            {formatRupees(band.subtotal.finAmtInPaise)}
                          </div>
                          <MiniBar fillRatio={band.subtotal.finAmtInPaise / max} color={CAT_COLOR[band.category]} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </SectionCard>
            )}

            {/* Line items */}
            {isLab ? (
              stmt.bands.map((band) => (
                <SectionCard key={band.category} padding={0}>
                  <div
                    className="flex items-center justify-between px-3 py-2"
                    style={{ background: "#fbf7ee", borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
                  >
                    <span className="font-medium" style={{ fontSize: 12 }}>{band.label}</span>
                    <span style={{ fontSize: 12, color: TOKENS.caution }}>
                      {formatRupees(band.subtotal.finAmtInPaise)}
                    </span>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table className="w-full" style={{ fontSize: 12, minWidth: 640 }}>
                      <thead>
                        <tr style={{ color: TOKENS.textTertiary, textAlign: "left" }}>
                          <th className="py-1.5 pl-3 font-normal">Date</th>
                          <th className="py-1.5 font-normal">Patient</th>
                          <th className="py-1.5 font-normal">Test</th>
                          <th className="py-1.5 font-normal">Rate</th>
                          <th className="py-1.5 text-right font-normal">Price</th>
                          <th className="py-1.5 text-right font-normal">Payable</th>
                          <th className="py-1.5 pr-3 text-right font-normal">Margin</th>
                        </tr>
                      </thead>
                      <tbody>
                        {band.rows.map((r, i) => {
                          const loss = (r.centerMarginInPaise ?? 0) < 0;
                          return (
                            <tr key={i} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                              <td className="py-1.5 pl-3" style={{ color: TOKENS.textTertiary }}>{formatIstDate(r.date)}</td>
                              <td className="py-1.5">{r.patientTitle ? `${r.patientTitle} ` : ""}{r.patientName}</td>
                              <td className="py-1.5">{r.testOrFee}</td>
                              <td className="py-1.5" style={{ color: TOKENS.textTertiary }}>{r.basisLabel}</td>
                              <td className="py-1.5 text-right tabular-nums">{formatRupees(r.pAmtInPaise)}</td>
                              <td className="py-1.5 text-right font-medium tabular-nums">{formatRupees(r.finAmtInPaise)}</td>
                              <td
                                className="py-1.5 pr-3 text-right tabular-nums"
                                style={{ color: loss ? TOKENS.critical : TOKENS.textSecondary }}
                              >
                                {formatRupees(r.centerMarginInPaise ?? 0)}{loss ? " ⚠" : ""}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
              ))
            ) : (
              <SectionCard padding={0}>
                <div
                  className="px-3 py-2"
                  style={{ background: "#f6f5f2", borderTopLeftRadius: 12, borderTopRightRadius: 12, fontSize: 12, fontWeight: 600 }}
                >
                  Line items
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="w-full" style={{ fontSize: 12, minWidth: 620 }}>
                    <thead>
                      <tr style={{ color: TOKENS.textTertiary, textAlign: "left" }}>
                        <th className="py-1.5 pl-3 font-normal">Date</th>
                        <th className="py-1.5 font-normal">Bill #</th>
                        <th className="py-1.5 font-normal">Patient</th>
                        <th className="py-1.5 text-right font-normal">T Amt</th>
                        <th className="py-1.5 text-right font-normal">Disc</th>
                        <th className="py-1.5 text-right font-normal">P Amt</th>
                        <th className="py-1.5 pr-3 text-right font-normal">Fin Amt</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupRowsByBill(stmt.bands).map((g) => (
                        <Fragment key={g.key}>
                          <tr style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                            <td className="py-1.5 pl-3" style={{ color: TOKENS.textTertiary }}>{formatIstDate(g.date)}</td>
                            <td className="py-1.5" style={{ color: TOKENS.textTertiary }}>{g.billNumber}</td>
                            <td className="py-1.5">{g.patient}</td>
                            <td className="py-1.5 text-right tabular-nums">{formatRupees(g.tAmt)}</td>
                            <td className="py-1.5 text-right tabular-nums">{formatRupees(g.disc)}</td>
                            <td className="py-1.5 text-right tabular-nums">{formatRupees(g.pAmt)}</td>
                            <td className="py-1.5 pr-3 text-right font-medium tabular-nums">{formatRupees(g.fin)}</td>
                          </tr>
                          <tr>
                            <td></td>
                            <td colSpan={6} className="pb-2" style={{ fontSize: 11 }}>
                              {g.items.map((it, i) => (
                                <span
                                  key={i}
                                  style={{
                                    display: "inline-block",
                                    background: "#f0efe9",
                                    border: `1px solid ${TOKENS.border}`,
                                    borderRadius: 5,
                                    padding: "1px 7px",
                                    margin: "2px 5px 0 0",
                                  }}
                                >
                                  <span
                                    style={{
                                      display: "inline-block",
                                      width: 7,
                                      height: 7,
                                      borderRadius: "50%",
                                      background: CAT_COLOR[it.category],
                                      marginRight: 5,
                                      verticalAlign: "middle",
                                    }}
                                  />
                                  {it.testOrFee}{" "}
                                  <span style={{ color: TOKENS.textTertiary }}>({it.basisLabel})</span>
                                </span>
                              ))}
                            </td>
                          </tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SectionCard>
            )}

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
          <StatementPrint stmt={stmt} />
          </>
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

// Print-only document (visible only when printing, per the global .print-content rule).
function StatementPrint({ stmt }: { stmt: Statement }) {
  const isLab = stmt.isLab;
  const period = `${formatIstDate(stmt.periodStartDate)} – ${formatIstDate(stmt.periodEndDate)}`;
  const td: CSSProperties = { border: "1px solid #999", padding: "3px 5px", fontSize: 10 };
  const th: CSSProperties = { ...td, background: "#eee", fontWeight: 600, textAlign: "center" };
  const rt: CSSProperties = { textAlign: "right" };
  return (
    <div className="hidden print:block print-content print-page">
      <div style={{ textAlign: "center", borderBottom: "2px solid #111", paddingBottom: 8, marginBottom: 12 }}>
        <img src={LOGO_URL} alt="Sobhana" style={{ height: 46 }} />
        <div style={{ fontWeight: 700, letterSpacing: "0.12em", marginTop: 6, fontSize: 13 }}>
          {docTitle(stmt)}
        </div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 10 }}>
        <div>
          <b>{stmt.payeeName}</b>
          <br />
          Period: {period}
        </div>
        <div style={{ textAlign: "right" }}>
          Branch: {stmt.branchName || "—"}
          <br />
          Status: {stmt.status === "PAID" ? "Paid" : isLab ? "Unpaid" : "Pending"}
          {stmt.status === "PAID" && stmt.paidAt
            ? ` (${formatIstDate(stmt.paidAt)}${stmt.paymentMethod ? " · " + stmt.paymentMethod : ""})`
            : ""}
        </div>
      </div>
      {stmt.bands.map((band) => (
        <table key={band.category} style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }} colSpan={4}>
                {band.label}
              </th>
              <th style={th}>T Amt</th>
              <th style={th}>Disc</th>
              <th style={th}>P Amt</th>
              <th style={th}>{isLab ? "Payable" : "Fin"}</th>
              {isLab && <th style={th}>Margin</th>}
            </tr>
          </thead>
          <tbody>
            {band.rows.map((row, i) => (
              <tr key={i}>
                <td style={td}>{formatIstDate(row.date)}</td>
                <td style={td}>{row.billNumber}</td>
                <td style={td}>{row.patientName}</td>
                <td style={td}>
                  {row.testOrFee} <span style={{ color: "#666" }}>({row.basisLabel})</span>
                </td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.tAmtInPaise)}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.discInPaise)}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.pAmtInPaise)}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.finAmtInPaise)}</td>
                {isLab && <td style={{ ...td, ...rt }}>{formatRupees(row.centerMarginInPaise ?? 0)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <div
        style={{
          borderTop: "2px solid #111",
          paddingTop: 6,
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        <span>GRAND TOTAL</span>
        <span>
          T {formatRupees(stmt.grandTotal.tAmtInPaise)} · Disc {formatRupees(stmt.grandTotal.discInPaise)} · P{" "}
          {formatRupees(stmt.grandTotal.pAmtInPaise)} · {isLab ? "Payable" : "Fin"}{" "}
          {formatRupees(stmt.grandTotal.finAmtInPaise)}
        </span>
      </div>
      {stmt.status === "PAID" ? (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          Payment received: {formatRupees(stmt.grandTotal.finAmtInPaise)} · {stmt.paymentMethod ?? ""}
          {stmt.paymentReferenceId ? " · ref " + stmt.paymentReferenceId : ""}
          {stmt.paidAt ? " · " + formatIstDate(stmt.paidAt) : ""}
          <div style={{ marginTop: 32, textAlign: "right" }}>
            ____________________
            <br />
            Authorised signatory
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 10, fontSize: 11 }}>
          Amount payable: <b>{formatRupees(stmt.grandTotal.finAmtInPaise)}</b> · Status: Pending
        </div>
      )}
    </div>
  );
}

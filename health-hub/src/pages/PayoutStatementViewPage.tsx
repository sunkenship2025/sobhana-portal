import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, AlertTriangle } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { formatRupees } from "@/lib/payoutFormatters";
import { SectionCard, TOKENS, formatIstDate } from "./owner/_shared/ownerUi";
import type { PayoutStatement } from "@/types";

const LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

/**
 * Public, token-gated read-only payout statement — the target of the WhatsApp
 * link sent to a doctor/clinic/centre/lab. No auth, no AppLayout shell.
 */
export default function PayoutStatementViewPage() {
  const [params] = useSearchParams();
  const token = params.get("token");

  const [stmt, setStmt] = useState<PayoutStatement | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setNotFound(true);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/statements/view/${token}`);
        if (!res.ok) {
          if (alive) setNotFound(true);
          return;
        }
        const body = await res.json();
        if (alive) setStmt((body.data ?? null) as PayoutStatement);
      } catch {
        if (alive) setNotFound(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: TOKENS.page }}>
        <Loader2 className="h-6 w-6 animate-spin" style={{ color: TOKENS.textTertiary }} />
      </div>
    );
  }

  if (notFound || !stmt) {
    return (
      <div
        className="flex min-h-screen flex-col items-center justify-center gap-2 px-6 text-center"
        style={{ background: TOKENS.page }}
      >
        <AlertTriangle className="h-7 w-7" style={{ color: TOKENS.caution }} />
        <div style={{ fontSize: 15, fontWeight: 600 }}>Statement not available</div>
        <div style={{ fontSize: 13, color: TOKENS.textTertiary, maxWidth: 360 }}>
          This link is invalid or has expired. Please ask Sobhana Diagnostics to resend it.
        </div>
      </div>
    );
  }

  const isLab = stmt.isLab;
  const accent = isLab ? TOKENS.caution : TOKENS.textPrimary;
  const period = `${formatIstDate(stmt.periodStartDate)} – ${formatIstDate(stmt.periodEndDate)}`;

  return (
    <div style={{ background: TOKENS.page, minHeight: "100vh" }}>
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "20px 16px 48px" }}>
        {/* Letterhead */}
        <div
          style={{
            textAlign: "center",
            borderBottom: "2px solid #111",
            paddingBottom: 10,
            marginBottom: 16,
          }}
        >
          <img src={LOGO_URL} alt="Sobhana" style={{ height: 50, margin: "0 auto" }} />
          <div style={{ fontWeight: 700, letterSpacing: "0.1em", marginTop: 6, fontSize: 12 }}>
            {isLab
              ? stmt.status === "PAID"
                ? "OUTSIDE LAB — PAYMENT VOUCHER"
                : "OUTSIDE LAB PAYABLE"
              : stmt.status === "PAID"
                ? "PAYOUT RECEIPT"
                : "PAYOUT STATEMENT"}
          </div>
        </div>

        {/* Header */}
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
          <div className="mt-3 border-t pt-3" style={{ borderColor: TOKENS.border, fontSize: 13 }}>
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
              </span>
            )}
          </div>
        </SectionCard>

        {/* Bands */}
        <div className="mt-4 space-y-4">
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
              <div style={{ overflowX: "auto" }}>
                <table className="w-full" style={{ fontSize: 12, minWidth: 560 }}>
                  <thead>
                    <tr style={{ color: TOKENS.textTertiary, textAlign: "left" }}>
                      <th className="py-1.5 pl-3 font-normal">Date</th>
                      <th className="py-1.5 font-normal">Patient</th>
                      <th className="py-1.5 font-normal">Test / fee</th>
                      <th className="py-1.5 font-normal">Basis</th>
                      <th className="py-1.5 text-right font-normal">P Amt</th>
                      <th className="py-1.5 pr-3 text-right font-normal">
                        {isLab ? "Payable" : "Fin Amt"}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {band.rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                        <td className="py-1.5 pl-3" style={{ color: TOKENS.textTertiary }}>
                          {formatIstDate(r.date)}
                        </td>
                        <td className="py-1.5">
                          {r.patientTitle ? `${r.patientTitle} ` : ""}
                          {r.patientName}
                        </td>
                        <td className="py-1.5">{r.testOrFee}</td>
                        <td className="py-1.5" style={{ color: TOKENS.textTertiary }}>{r.basisLabel}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatRupees(r.pAmtInPaise)}</td>
                        <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                          {formatRupees(r.finAmtInPaise)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ))}
        </div>

        {/* Grand total */}
        <div
          className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl px-4 py-3"
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

        <div style={{ textAlign: "center", marginTop: 20, fontSize: 11, color: TOKENS.textTertiary }}>
          Sobhana Diagnostics · This statement was shared with you securely.
        </div>
      </div>
    </div>
  );
}

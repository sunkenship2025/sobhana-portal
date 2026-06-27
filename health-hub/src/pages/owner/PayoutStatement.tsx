import { useEffect, useState, Fragment, type CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import type {
  PayoutStatement as Statement,
  StatementBand,
  PayoutCategory,
} from "@/types";

// Categories are centre-defined, so colours are derived deterministically from
// the label (stable across renders) rather than a fixed map.
const CAT_PALETTE = ["#6f86a8", "#a8896f", "#8a93a3", "#9a9a6f", "#7f9c8b", "#a07f9c", "#888780"];
function catColor(category: PayoutCategory): string {
  let h = 0;
  for (let i = 0; i < category.length; i++) h = (h * 31 + category.charCodeAt(i)) >>> 0;
  return CAT_PALETTE[h % CAT_PALETTE.length];
}

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
  return s.isLab ? "OUTSIDE LAB STATEMENT" : "PAYOUT STATEMENT";
}

export default function PayoutStatement() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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

  // Deep-link reprint: /owner/payouts/:id?print=1 opens straight to the print
  // dialog (used by the "reprint" shortcut on PAID rows). Consume the param so a
  // refresh doesn't re-trigger it.
  useEffect(() => {
    if (stmt && searchParams.get("print") === "1") {
      const t = setTimeout(() => window.print(), 400);
      const next = new URLSearchParams(searchParams);
      next.delete("print");
      setSearchParams(next, { replace: true });
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stmt]);

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
                onClick={() => navigate(-1)}
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
                {stmt && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={sendWhatsApp}
                    disabled={sendingWa || !stmt.whatsappEnabled || !stmt.payeeHasPhone}
                    title={
                      !stmt.whatsappEnabled
                        ? "WhatsApp isn't enabled for this branch yet"
                        : !stmt.payeeHasPhone
                          ? "No phone number on file for this payee"
                          : "Send this statement to the payee on WhatsApp"
                    }
                  >
                    <MessageCircle className="mr-1.5 h-4 w-4" /> {sendingWa ? "Sending…" : "WhatsApp"}
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
                  <button
                    onClick={() =>
                      navigate(isLab ? "/owner/payouts/labs" : "/owner/config?tab=referrals")
                    }
                    style={{ fontSize: 12, color: TOKENS.info, marginTop: 4 }}
                  >
                    {isLab ? "Manage this lab's rates →" : "Manage referral settings →"}
                  </button>
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
                          <MiniBar fillRatio={band.subtotal.finAmtInPaise / max} color={catColor(band.category)} />
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
                        <th className="py-1.5 pr-3 text-right font-normal">Payable</th>
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
                                      background: catColor(it.category),
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
                Payable <b>{formatRupees(stmt.grandTotal.finAmtInPaise)}</b>
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
    </AppLayout>
  );
}

// Group one band's (category's) line items into per-bill rows for the print.
function groupBillsInBand(band: StatementBand) {
  const map = new Map<
    string,
    {
      key: string;
      billNumber: string;
      date: string;
      patient: string;
      tAmt: number;
      disc: number;
      pAmt: number;
      fin: number;
      tests: string[];
    }
  >();
  for (const r of band.rows) {
    const key = `${r.billNumber}|${r.patientName}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        billNumber: r.billNumber,
        date: r.date,
        patient: `${r.patientTitle ? r.patientTitle + " " : ""}${r.patientName}`,
        tAmt: 0,
        disc: 0,
        pAmt: 0,
        fin: 0,
        tests: [],
      };
      map.set(key, g);
    }
    g.tAmt += r.tAmtInPaise;
    g.disc += r.discInPaise;
    g.pAmt += r.pAmtInPaise;
    g.fin += r.finAmtInPaise;
    g.tests.push(r.testOrFee);
    if (new Date(r.date) < new Date(g.date)) g.date = r.date;
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
}

// Print-only document (visible only when printing, per the global .print-content rule).
// Legacy-style layout: per-bill rows with category columns + tests underneath.
function StatementPrint({ stmt }: { stmt: Statement }) {
  const isLab = stmt.isLab;
  const period = `${formatIstDate(stmt.periodStartDate)} – ${formatIstDate(stmt.periodEndDate)}`;
  const td: CSSProperties = { border: "1px solid #999", padding: "3px 4px", fontSize: 9, textAlign: "center" };
  const th: CSSProperties = { ...td, background: "#eee", fontWeight: 600 };
  const lt: CSSProperties = { textAlign: "left" };
  const rt: CSSProperties = { textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const r0 = (p: number) => (p ? formatRupees(p) : "—");

  const labRows = stmt.bands.flatMap((b) => b.rows);
  const billCount = new Set(
    stmt.bands.flatMap((b) => b.rows.map((r) => `${r.billNumber}|${r.patientName}`))
  ).size;

  return (
    <div className="hidden print:block print-content print-page">
      {/* Letterhead */}
      <div style={{ textAlign: "center", borderBottom: "2px solid #111", paddingBottom: 8, marginBottom: 10 }}>
        <img src={LOGO_URL} alt="Sobhana" style={{ height: 46 }} />
        <div style={{ fontWeight: 700, letterSpacing: "0.14em", marginTop: 6, fontSize: 13 }}>
          {docTitle(stmt).toUpperCase()}
        </div>
      </div>

      {/* Meta */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, marginBottom: 8 }}>
        <div>
          <b>{stmt.payeeName}</b> — {isLab ? "Outside Lab" : "Referral / Clinic"}
          <br />
          Period: {period}
        </div>
        <div style={{ textAlign: "right" }}>
          Branch: {stmt.branchName || "—"} · #{stmt.id.slice(-6).toUpperCase()}
          <br />
          Generated: {formatIstDate(new Date().toISOString())}
        </div>
      </div>

      {/* Table */}
      {isLab ? (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Sln</th>
              <th style={{ ...th, ...lt }}>Date</th>
              <th style={{ ...th, ...lt }}>Patient</th>
              <th style={{ ...th, ...lt }}>Test</th>
              <th style={{ ...th, ...lt }}>Rate</th>
              <th style={th}>Price</th>
              <th style={th}>Payable</th>
              <th style={th}>Margin</th>
            </tr>
          </thead>
          <tbody>
            {labRows.map((row, i) => (
              <tr key={i}>
                <td style={td}>{i + 1}</td>
                <td style={{ ...td, ...lt }}>{formatIstDate(row.date)}</td>
                <td style={{ ...td, ...lt }}>{row.patientName}</td>
                <td style={{ ...td, ...lt }}>{row.testOrFee}</td>
                <td style={{ ...td, ...lt }}>{row.basisLabel}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.pAmtInPaise)}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.finAmtInPaise)}</td>
                <td style={{ ...td, ...rt }}>{formatRupees(row.centerMarginInPaise ?? 0)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, background: "#f0f0f0" }}>
              <td style={{ ...td, ...lt }} colSpan={5}>GRAND TOTAL — {labRows.length} tests</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.pAmtInPaise)}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.finAmtInPaise)}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.centerMarginInPaise ?? 0)}</td>
            </tr>
          </tfoot>
        </table>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 26 }}>Sln</th>
              <th style={th}>Bill #</th>
              <th style={{ ...th, ...lt }}>Date</th>
              <th style={{ ...th, ...lt }}>Patient</th>
              <th style={th}>T Amt</th>
              <th style={th}>Disc</th>
              <th style={th}>P Amt</th>
              <th style={th}>Payable</th>
            </tr>
          </thead>
          {stmt.bands.map((band) => {
            const bills = groupBillsInBand(band);
            let n = 0;
            return (
              <tbody key={band.category}>
                <tr>
                  <td
                    style={{ ...td, ...lt, fontWeight: 700, background: "#f0f0f0" }}
                    colSpan={8}
                  >
                    {band.label}
                  </td>
                </tr>
                {bills.map((p) => {
                  n += 1;
                  return (
                    <Fragment key={p.key}>
                      <tr>
                        <td style={td}>{n}</td>
                        <td style={td}>{p.billNumber}</td>
                        <td style={{ ...td, ...lt }}>{formatIstDate(p.date)}</td>
                        <td style={{ ...td, ...lt }}>{p.patient}</td>
                        <td style={{ ...td, ...rt }}>{formatRupees(p.tAmt)}</td>
                        <td style={{ ...td, ...rt }}>{r0(p.disc)}</td>
                        <td style={{ ...td, ...rt }}>{formatRupees(p.pAmt)}</td>
                        <td style={{ ...td, ...rt, fontWeight: 700 }}>{formatRupees(p.fin)}</td>
                      </tr>
                      <tr>
                        <td style={td}></td>
                        <td style={{ ...td, ...lt, fontSize: 8, color: "#555" }} colSpan={7}>
                          {p.tests.join(", ")}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
                <tr style={{ fontWeight: 600, background: "#f8f8f6" }}>
                  <td style={{ ...td, ...lt }} colSpan={4}>{band.label} subtotal</td>
                  <td style={{ ...td, ...rt }}>{formatRupees(band.subtotal.tAmtInPaise)}</td>
                  <td style={{ ...td, ...rt }}>{r0(band.subtotal.discInPaise)}</td>
                  <td style={{ ...td, ...rt }}>{formatRupees(band.subtotal.pAmtInPaise)}</td>
                  <td style={{ ...td, ...rt }}>{formatRupees(band.subtotal.finAmtInPaise)}</td>
                </tr>
              </tbody>
            );
          })}
          <tfoot>
            <tr style={{ fontWeight: 700, background: "#f0f0f0" }}>
              <td style={{ ...td, ...lt }} colSpan={4}>GRAND TOTAL — {billCount} bills</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.tAmtInPaise)}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.discInPaise)}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.pAmtInPaise)}</td>
              <td style={{ ...td, ...rt }}>{formatRupees(stmt.grandTotal.finAmtInPaise)}</td>
            </tr>
          </tfoot>
        </table>
      )}

      {/* Payable + signature */}
      <div
        style={{
          marginTop: 12,
          border: "1px solid #999",
          borderLeft: "4px solid #1F1F1E",
          padding: "8px 10px",
          fontSize: 10.5,
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>
          <b>Amount payable: {formatRupees(stmt.grandTotal.finAmtInPaise)}</b>
        </span>
        <span style={{ color: "#666" }}>Discrepancies, if any, to be raised within 7 days.</span>
      </div>
      <div style={{ marginTop: 48, textAlign: "right", fontSize: 10.5 }}>
        Authorised signatory
      </div>

      <div style={{ textAlign: "center", marginTop: 14, fontSize: 9, color: "#666", borderTop: "1px solid #ccc", paddingTop: 6 }}>
        Computer-generated {docTitle(stmt).toLowerCase()} · Sobhana Diagnostics
      </div>
    </div>
  );
}

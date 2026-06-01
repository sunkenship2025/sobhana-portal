import type React from "react";
import { useEffect, useState } from "react";
import type { BillReceiptData } from "@/types";
import { API_BASE_URL } from "@/lib/api";
import { formatAgeDisplay } from "@/lib/validation";
import { formatPatientName } from "@/lib/patientDisplay";

interface BillReceiptProps {
  data: BillReceiptData;
  /** When true, render as a print-page (for multi-page docs like clinic prescription+bill) */
  asPage?: boolean;
  onLogoLoadedChange?: (loaded: boolean) => void;
}

const BILL_LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

export const BillReceipt = ({
  data,
  asPage = false,
  onLogoLoadedChange,
}: BillReceiptProps) => {
  const isDiagnostic = data.domain === "DIAGNOSTICS";
  const [logoLoaded, setLogoLoaded] = useState(false);

  // ── Date & Time ──
  const dateObj = new Date(data.date);
  const dateStr = dateObj.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const timeStr = dateObj.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // ── Gender ──
  const genderFull =
    data.patient.gender === "M"
      ? "MALE"
      : data.patient.gender === "F"
        ? "FEMALE"
        : "OTHER";

  // ── Visit type (clinic only) ──
  const visitTypeService = isDiagnostic
    ? undefined
    : data.visitType === "IP"
      ? "IP Consultation"
      : "OP Consultation";
  const visitTypeLabel = visitTypeService
    ? data.isRevisit
      ? `${visitTypeService} (Revisit)`
      : visitTypeService
    : undefined;

  // ── Financial calculations ──
  const hasBill = data.hasBill !== false;
  const subtotalAmount = data.totalAmount ?? 0;
  const discountAmount = (data.discountAmountInPaise ?? 0) / 100;
  const netAmount =
    data.netAmountInPaise !== undefined
      ? data.netAmountInPaise / 100
      : Math.max(0, subtotalAmount - discountAmount);
  const paidAmount =
    data.paidAmountInPaise !== undefined
      ? data.paidAmountInPaise / 100
      : data.paymentStatus === "PAID"
        ? netAmount
        : 0;
  const dueAmount =
    data.dueAmountInPaise !== undefined
      ? data.dueAmountInPaise / 100
      : Math.max(0, netAmount - paidAmount);

  // ── Discount label ──
  const discountLabel =
    data.discountType === "PERCENTAGE" && data.discountPercentage != null
      ? `Disc. Amount (${data.discountPercentage}%)`
      : "Disc. Amount";

  // ── Document number ──
  const documentNumberLabel = hasBill ? "Bill No" : "Visit Ref";
  const documentNumberValue = hasBill
    ? data.billNumber || data.visitRef || "—"
    : data.visitRef || data.billNumber || "—";

  // ── Payment status ──
  const normalizedPaymentStatus = (() => {
    const rawStatus = (data.paymentStatus || "").toString().toUpperCase();
    if (rawStatus.includes("PAID")) return "PAID";
    if (rawStatus.includes("PENDING")) return "PENDING";
    return data.paymentStatus || "—";
  })();
  const paymentSummary =
    data.hasBill !== false ? normalizedPaymentStatus : "Not billed";

  // ── Revisit info ──
  const revisitSummaryParts = [
    data.originalBillNumber ? `Bill ${data.originalBillNumber}` : null,
    data.originalVisitDate
      ? new Date(data.originalVisitDate).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : null,
  ].filter(Boolean);
  const revisitSummary = revisitSummaryParts.join(" • ");

  // ── Patient display ──
  const patientAgeDisplay = data.patient.ageDisplay?.trim()
    ? data.patient.ageDisplay
    : typeof data.patient.age === "number" && Number.isFinite(data.patient.age)
      ? formatAgeDisplay({
          age: data.patient.age,
          ageUnit: data.patient.ageUnit,
        })
      : "N/A";

  const patientNameFormatted = formatPatientName(
    data.patient.name,
    (data.patient as any).title,
    true,
  );

  const referredBy = data.referralDoctor?.name?.trim() || "SELF";

  // ── Format amount with Indian commas ──
  const fmt = (n: number) =>
    n.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  // ── Container class ──
  const containerClass = asPage
    ? "print-page bill-receipt-page"
    : "print-content bg-white text-black";

  // ── Logo preload ──
  useEffect(() => {
    setLogoLoaded(false);
    onLogoLoadedChange?.(false);

    const image = new Image();
    image.onload = () => {
      setLogoLoaded(true);
      onLogoLoadedChange?.(true);
    };
    image.onerror = () => {
      setLogoLoaded(true);
      onLogoLoadedChange?.(true);
    };
    image.src = BILL_LOGO_URL;

    if (image.complete) {
      setLogoLoaded(true);
      onLogoLoadedChange?.(true);
    }

    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [onLogoLoadedChange]);

  const clinicLabel = isDiagnostic
    ? "Sobhana Diagnostic Centre"
    : "Sobhana Clinic";

  return (
    <div className={containerClass}>
      {/* Master container: solid black border, dynamic height */}
      <div
        className="mx-auto w-full border border-black bg-white text-black"
        style={{
          maxWidth: "710px",
          fontFamily:
            "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          fontSize: "13px",
        }}
      >
        {/* ─── 1. HEADER ─── */}
        <div className="border-b border-black px-4 py-3 text-center">
          <div className="flex justify-center mb-1">
            <img
              src={BILL_LOGO_URL}
              alt="Sobhana"
              style={{
                height: "48px",
                objectFit: "contain",
                visibility: logoLoaded ? "visible" : "hidden",
              }}
              loading="eager"
              decoding="sync"
            />
          </div>
          {data.branchName && (
            <div
              className="uppercase tracking-widest mb-1"
              style={{ fontSize: "11px" }}
            >
              {data.branchName}
            </div>
          )}
          <div style={{ fontSize: "11px", lineHeight: "1.5" }}>
            #4-8-261/3 &amp; 14/NR, Beside Ridge Towers, IDPL, Surya Nagar,
            Chintal, Hyd - 500037.
          </div>
          <div style={{ fontSize: "11px" }}>
            Phone : 040-23089999, 9490539006.
          </div>
          <div className="mt-1 font-semibold" style={{ fontSize: "12px" }}>
            Requisition cum Receipt
          </div>
        </div>

        {/* ─── 2. PATIENT DETAILS (3-column grid) ─── */}
        <div className="border-b border-black px-4 py-2">
          <table
            className="w-full"
            style={{ fontSize: "12px", borderCollapse: "collapse" }}
          >
            <tbody>
              <tr>
                <td
                  className="py-0.5 whitespace-nowrap"
                  style={{ width: "40%" }}
                >
                  <span className="inline-block" style={{ width: "100px" }}>
                    {documentNumberLabel}
                  </span>
                  <span>: {documentNumberValue}</span>
                </td>
                <td
                  className="py-0.5 whitespace-nowrap"
                  style={{ width: "30%" }}
                >
                  <span className="inline-block" style={{ width: "50px" }}>
                    Age
                  </span>
                  <span>: {patientAgeDisplay}</span>
                </td>
                <td
                  className="py-0.5 whitespace-nowrap text-right"
                  style={{ width: "30%" }}
                >
                  <span>Date : {dateStr}</span>
                </td>
              </tr>
              <tr>
                <td className="py-0.5">
                  <span className="inline-block" style={{ width: "100px" }}>
                    Patient Name
                  </span>
                  <span>: {patientNameFormatted}</span>
                </td>
                <td className="py-0.5 whitespace-nowrap">
                  <span className="inline-block" style={{ width: "50px" }}>
                    Phone
                  </span>
                  <span>: {data.patient.phone || "N/A"}</span>
                </td>
                <td className="py-0.5 whitespace-nowrap text-right">
                  <span>Sex : {genderFull}</span>
                </td>
              </tr>
              <tr>
                <td className="py-0.5">
                  <span className="inline-block" style={{ width: "100px" }}>
                    Referred by
                  </span>
                  <span>: {referredBy}</span>
                </td>
                <td className="py-0.5 whitespace-nowrap">
                  <span className="inline-block" style={{ width: "50px" }}>
                    Payment
                  </span>
                  <span>: {paymentSummary}</span>
                </td>
                <td className="py-0.5 whitespace-nowrap text-right">
                  <span>Time : {timeStr}</span>
                </td>
              </tr>
              {/* Consulting Doctor (clinic only) */}
              {data.doctor && (
                <tr>
                  <td className="py-0.5" colSpan={2}>
                    <span className="inline-block" style={{ width: "100px" }}>
                      Doctor
                    </span>
                    <span>
                      : {data.doctor.name}
                      {data.doctor.qualification
                        ? `, ${data.doctor.qualification}`
                        : ""}
                      {data.doctor.specialty
                        ? ` (${data.doctor.specialty})`
                        : ""}
                    </span>
                  </td>
                  <td className="py-0.5">&nbsp;</td>
                </tr>
              )}
              {/* Visit type (clinic only) */}
              {visitTypeLabel && (
                <tr>
                  <td className="py-0.5" colSpan={2}>
                    <span className="inline-block" style={{ width: "100px" }}>
                      Visit Type
                    </span>
                    <span>: {visitTypeLabel}</span>
                  </td>
                  {data.isRevisit && revisitSummary ? (
                    <td className="py-0.5 whitespace-nowrap text-right">
                      <span style={{ fontSize: "11px" }}>
                        ({revisitSummary})
                      </span>
                    </td>
                  ) : (
                    <td className="py-0.5">&nbsp;</td>
                  )}
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ─── 3. INVESTIGATION TABLE ─── */}
        <div>
          {/* Table Header */}
          <div
            className="border-b border-black px-4 py-1.5 font-bold"
            style={{ fontSize: "12px" }}
          >
            <div className="flex">
              <div style={{ width: "50px" }}>S.No</div>
              <div className="flex-1">
                {isDiagnostic ? "Investigation" : "Service Description"}
              </div>
              <div style={{ width: "100px" }} className="text-right">
                Price
              </div>
            </div>
          </div>

          {/* Table Body */}
          <div className="border-b border-black">
            {data.items.map((item, index) => (
              <div
                key={item.id}
                className="px-4 py-2"
                style={{ fontSize: "12px" }}
              >
                <div className="flex">
                  <div style={{ width: "50px" }}>{index + 1}</div>
                  <div className="flex-1">{item.name}</div>
                  <div
                    style={{
                      width: "100px",
                      fontVariantNumeric: "tabular-nums",
                    }}
                    className="text-right"
                  >
                    {fmt(item.price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ─── 4. SPLIT FOOTER ─── */}
        <div className="flex" style={{ fontSize: "12px" }}>
          {/* Left: Signatory */}
          <div
            className="border-r border-black flex flex-col justify-between px-4 py-3"
            style={{ width: "50%" }}
          >
            <div className="text-center">For {clinicLabel}</div>
            <div className="text-center mt-10">Authorized Signatory</div>
          </div>

          {/* Right: Totals */}
          <div
            className="px-4 py-3 flex flex-col justify-between"
            style={{ width: "50%" }}
          >
            <div>
              <div className="flex justify-between py-0.5">
                <span>Total Amount</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  : {fmt(subtotalAmount)}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>Paid Amount</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  : {fmt(paidAmount)}
                </span>
              </div>
              <div className="flex justify-between py-0.5">
                <span>{discountLabel}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  : {fmt(discountAmount)}
                </span>
              </div>
              <div className="flex justify-between py-0.5 font-bold">
                <span>Due Amount</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  : {fmt(dueAmount)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* ─── 5. REVISIT NOTE (clinic only) ─── */}
        {!isDiagnostic && hasBill && (
          <div className="border-t border-black px-4 py-2">
            <p style={{ fontSize: "11px" }}>
              <strong>Note:</strong>{" "}
              <em>
                This receipt is valid for a free revisit within 7 days from the
                date of issue for the same complaint with the same consultant.
                Please carry this bill for the follow-up visit.
              </em>
            </p>
          </div>
        )}

        {/* ─── 6. TRUST FOOTER ─── */}
        <div className="border-t border-black px-4 py-2 text-center">
          <p style={{ fontSize: "11px" }} className="mb-0.5">
            We appreciate your trust in Sobhana.
          </p>
          <p
            style={{ fontSize: "10px", letterSpacing: "0.05em" }}
            className="uppercase"
          >
            * This is a computer generated invoice *
          </p>
        </div>
      </div>
    </div>
  );
};

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

// B&W Logo fallback if SVG is not sufficient, but per requirements we use an SVG placeholder
// and keep it clean.
const BILL_LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

export const BillReceipt = ({
  data,
  asPage = false,
  onLogoLoadedChange,
}: BillReceiptProps) => {
  const isDiagnostic = data.domain === "DIAGNOSTICS";
  const [logoLoaded, setLogoLoaded] = useState(false);

  const dateObj = new Date(data.date);
  const dateStr = dateObj.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  
  const timeStr = dateObj.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const genderFull =
    data.patient.gender === "M"
      ? "M"
      : data.patient.gender === "F"
        ? "F"
        : "O";

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

  const documentNumberLabel = hasBill ? "Rct No" : "Ref No";
  const documentNumberValue = hasBill
    ? data.billNumber || data.visitRef || "—"
    : data.visitRef || data.billNumber || "—";

  const patientAgeDisplay = data.patient.ageDisplay?.trim()
    ? data.patient.ageDisplay
    : typeof data.patient.age === "number" && Number.isFinite(data.patient.age)
      ? formatAgeDisplay({
          age: data.patient.age,
          ageUnit: data.patient.ageUnit,
        })
      : "N/A";

  const patientNameFormatted = formatPatientName(data.patient.name, (data.patient as any).title, true);
  // Flattened demographic string as requested: "Mr. KARUNAKAR (50Y/M)"
  const patientDemographicString = `${patientNameFormatted} (${patientAgeDisplay}/${genderFull})`;

  // Container classes
  const containerClass = asPage
    ? "print-page bill-receipt-page font-sans"
    : "print-content pt-8 pb-8 px-8 bg-white font-sans";

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

  const clinicName = isDiagnostic ? "SOBHANA DIAGNOSTIC CENTRE" : "SOBHANA CLINIC";

  return (
    <div className={containerClass}>
      <div className="mx-auto w-full max-w-[800px]">
        {/* SECTION A: The Header */}
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center gap-4">
            {/* Geometric Logo Placeholder / B&W Logo */}
            <div className="w-12 h-12 flex items-center justify-center shrink-0">
              <svg className="w-full h-full text-indigo-900" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2L2 22h20L12 2zm0 4.5l6.5 13h-13L12 6.5z" />
              </svg>
            </div>
            <div className="flex flex-col justify-center h-12">
              <h1 className="text-xl font-bold text-indigo-900 tracking-tight leading-none m-0">
                {clinicName}
              </h1>
            </div>
          </div>
          
          <div className="text-right text-xs font-light text-neutral-800 leading-relaxed max-w-sm">
            #4-8-261/3 & 14/NR, Beside Ridge Towers, IDPL, Surya Nagar, Chintal, Hyd - 500037 | Phone: 040-23089999, 9490539006
          </div>
        </div>

        {/* Document Title */}
        <div className="mb-4">
          <h2 className="text-sm font-medium text-gray-500 uppercase tracking-widest">
            REQUISITION CUM RECEIPT
          </h2>
        </div>

        {/* SECTION B: Patient Details (The Bounding Box) */}
        <div className="relative border border-gray-200 rounded-sm p-4 mb-8">
          {/* Mock Barcode Element */}
          <div className="absolute top-4 right-4 text-gray-300 opacity-50" aria-hidden="true">
            <svg width="80" height="24" viewBox="0 0 80 24" fill="currentColor">
              <rect x="0" y="0" width="2" height="24" />
              <rect x="4" y="0" width="4" height="24" />
              <rect x="10" y="0" width="2" height="24" />
              <rect x="14" y="0" width="6" height="24" />
              <rect x="22" y="0" width="2" height="24" />
              <rect x="26" y="0" width="2" height="24" />
              <rect x="30" y="0" width="8" height="24" />
              <rect x="40" y="0" width="2" height="24" />
              <rect x="44" y="0" width="4" height="24" />
              <rect x="50" y="0" width="2" height="24" />
              <rect x="54" y="0" width="6" height="24" />
              <rect x="62" y="0" width="2" height="24" />
              <rect x="66" y="0" width="4" height="24" />
              <rect x="72" y="0" width="2" height="24" />
              <rect x="76" y="0" width="4" height="24" />
            </svg>
          </div>

          <div className="grid grid-cols-3 gap-y-4 gap-x-6 pr-24">
            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">{documentNumberLabel}</span>
              <span className="text-sm text-neutral-800 font-semibold">{documentNumberValue}</span>
            </div>
            
            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">Date</span>
              <span className="text-sm text-neutral-800 font-semibold">{dateStr}</span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">Time</span>
              <span className="text-sm text-neutral-800 font-semibold">{timeStr}</span>
            </div>

            <div className="flex flex-col gap-1 col-span-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">Patient</span>
              <span className="text-sm text-neutral-800 font-semibold truncate">{patientDemographicString}</span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">Phone</span>
              <span className="text-sm text-neutral-800 font-semibold">{data.patient.phone || "N/A"}</span>
            </div>

            <div className="flex flex-col gap-1">
              <span className="text-xs text-neutral-400 uppercase tracking-wider">Ref By</span>
              <span className="text-sm text-neutral-800 font-semibold truncate">
                {data.referralDoctor?.name?.trim() ? `Dr. ${data.referralDoctor.name.replace(/^Dr\.\s*/i, '')}` : "SELF"}
              </span>
            </div>
          </div>
        </div>

        {/* SECTION C: The Investigation Table (No Lines) */}
        <div className="mb-6">
          <div className="grid grid-cols-[60px_1fr_120px] bg-indigo-900 text-white py-2 px-4 rounded-sm print:bg-indigo-900 print:text-white [print-color-adjust:exact]">
            <div className="text-xs font-semibold tracking-wider">S.NO</div>
            <div className="text-xs font-semibold tracking-wider pl-2">{isDiagnostic ? "INVESTIGATION" : "SERVICE DESCRIPTION"}</div>
            <div className="text-xs font-semibold tracking-wider text-right">AMOUNT (₹)</div>
          </div>

          <div className="flex flex-col pt-2">
            {data.items.map((item, index) => (
              <div key={item.id} className="grid grid-cols-[60px_1fr_120px] px-4 py-2.5 items-center">
                <div className="text-sm text-neutral-800">{index + 1}</div>
                <div className="text-sm text-neutral-800 pl-2">{item.name}</div>
                <div className="text-sm text-neutral-800 text-right tabular-nums font-medium">
                  {item.price.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* SECTION D: The Footer & Totals (Zero Clutter) */}
        <div className="flex justify-end mb-16">
          <div className="w-72">
            <div className="border-t border-gray-200 flex justify-between pt-3 pb-2">
              <span className="text-sm text-neutral-400">Total & Paid Amount:</span>
              <span className="text-sm text-neutral-800 tabular-nums font-medium">{netAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-sm text-neutral-400">Due Amount:</span>
              <span className="text-sm text-neutral-800 tabular-nums font-bold">{dueAmount.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Signatories & Trust Message */}
        <div className="relative mt-8">
          <div className="absolute bottom-0 left-0">
            <div className="w-40 border-t border-gray-200 pt-2 text-left">
              <p className="text-xs text-neutral-400 font-medium">Authorized Signatory</p>
              <p className="text-[10px] text-neutral-400 mt-1 uppercase">User: ADMIN</p>
            </div>
          </div>
          
          <div className="text-center w-full pt-12 pb-4">
            <p className="text-[10px] text-gray-400 tracking-[0.2em] uppercase font-light">
              We appreciate your trust in Sobhana. * THIS IS A COMPUTER GENERATED INVOICE *
            </p>
          </div>
        </div>

      </div>
    </div>
  );
};


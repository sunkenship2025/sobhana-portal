import { useEffect, useState } from 'react';
import type { BillReceiptData } from '@/types';
import { API_BASE_URL } from '@/lib/api';
import { formatAgeDisplay } from '@/lib/validation';

interface BillReceiptProps {
  data: BillReceiptData;
  /** When true, render as a print-page (for multi-page docs like clinic prescription+bill) */
  asPage?: boolean;
  onLogoLoadedChange?: (loaded: boolean) => void;
}

/**
 * Shared bill receipt component used by:
 * - ClinicPrescriptionPrint (Page 2)
 * - DiagnosticsNewVisit (inline print)
 * - BillPrintPage (Patient360 reprint)
 */
const BILL_LOGO_URL = `${API_BASE_URL}/images/sobhana-clinic-logo.png`;

export const BillReceipt = ({ data, asPage = false, onLogoLoadedChange }: BillReceiptProps) => {
  const isDiagnostic = data.domain === 'DIAGNOSTICS';
  const [logoLoaded, setLogoLoaded] = useState(false);

  const dateStr = new Date(data.date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });

  const genderFull = data.patient.gender === 'M' ? 'Male' : data.patient.gender === 'F' ? 'Female' : 'Other';

  const visitTypeService = isDiagnostic
    ? undefined
    : data.visitType === 'IP'
      ? 'IP Consultation'
      : 'OP Consultation';
  const visitTypeLabel = visitTypeService
    ? data.isRevisit
      ? `${visitTypeService} (Revisit)`
      : visitTypeService
    : undefined;
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
      : data.paymentStatus === 'PAID'
        ? netAmount
        : 0;
  const dueAmount =
    data.dueAmountInPaise !== undefined
      ? data.dueAmountInPaise / 100
      : Math.max(0, netAmount - paidAmount);
  const discountLabel =
    data.discountType === 'PERCENTAGE' && data.discountPercentage != null
      ? `DISCOUNT (${data.discountPercentage}%)`
      : 'DISCOUNT';
  const documentNumberLabel = hasBill ? 'Bill No' : 'Visit Ref';
  const documentNumberValue = hasBill
    ? data.billNumber || data.visitRef || '—'
    : data.visitRef || data.billNumber || '—';
  const paymentSummary = hasBill
    ? `${data.paymentType || '—'} / ${data.paymentStatus || '—'}`
    : 'Not billed';
  const revisitSummaryParts = [
    data.originalBillNumber ? `Bill ${data.originalBillNumber}` : null,
    data.originalVisitDate
      ? new Date(data.originalVisitDate).toLocaleDateString('en-IN', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : null,
  ].filter(Boolean);
  const revisitSummary = revisitSummaryParts.join(' • ');
  const patientAgeDisplay = data.patient.ageDisplay?.trim()
    ? data.patient.ageDisplay
    : typeof data.patient.age === 'number' && Number.isFinite(data.patient.age)
      ? formatAgeDisplay({
          age: data.patient.age,
          ageUnit: data.patient.ageUnit,
        })
      : 'N/A';

  const showDiscount = discountAmount > 0;
  const hasCalculations = showDiscount || netAmount !== subtotalAmount;
  const showSubtotal = data.items.length > 1 || showDiscount || paidAmount > 0;
  const showPaid = paidAmount > 0;
  const showDue = dueAmount > 0;
  const finalTotalLabel = hasCalculations ? 'FINAL TOTAL' : 'TOTAL';

  // Container classes: if asPage, use print-page styling; otherwise standalone print-content
  const containerClass = asPage
    ? 'print-page bill-receipt-page'
    : 'print-content pt-6 pb-8 px-6 bg-white text-black';

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

  return (
    <div className={containerClass}>
      <div className="mx-auto w-full max-w-[710px]">
        {/* Logo Header - Centered */}
        <div className="flex justify-center mb-0">
          <img
            src={BILL_LOGO_URL}
            alt="Sobhana"
            style={{ height: '60px', objectFit: 'contain', visibility: logoLoaded ? 'visible' : 'hidden' }}
            loading="eager"
            decoding="sync"
          />
        </div>
        {data.branchName && (
          <p className="text-center text-xs tracking-widest uppercase mb-2">{data.branchName}</p>
        )}
        <div className="border-t-2 border-black mb-4"></div>

        {/* Bill Info Row */}
        <div className="grid grid-cols-2 gap-8 text-sm mb-4">
          <div className="space-y-1">
            <p><strong>{documentNumberLabel}:</strong>&ensp;{documentNumberValue}</p>
            <p><strong>Date:</strong>&ensp;{dateStr}</p>
            {visitTypeLabel && (
              <p><strong>Visit Type:</strong>&ensp;{visitTypeLabel}</p>
            )}
          </div>
          <div className="space-y-1 text-right">
            <p><strong>Payment:</strong>&ensp;{paymentSummary}</p>
            {data.isRevisit && (
              <p><strong>Revisit:</strong>&ensp;{revisitSummary || 'Follow-up visit'}</p>
            )}
          </div>
        </div>

        {/* Patient Details Box */}
        <div className="border border-black px-4 py-3 mb-4">
          <h2 className="font-bold text-sm mb-3">Patient Details</h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 min-w-0">
              <strong>Name:</strong>
              <span className="min-w-0 truncate">{data.patient.name.toUpperCase()}</span>
            </div>
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 min-w-0 justify-self-start">
              <strong>Phone:</strong>
              <span>{data.patient.phone || 'N/A'}</span>
            </div>
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 min-w-0">
              <strong>Age:</strong>
              <span>{patientAgeDisplay}</span>
            </div>
            <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 min-w-0 justify-self-start">
              <strong>Gender:</strong>
              <span>{genderFull}</span>
            </div>
          </div>
        </div>

        {/* Consulting Doctor */}
        {data.doctor && (
          <p className="text-sm mb-3">
            <strong>Consulting Doctor:</strong>&ensp;{data.doctor.name}
            {data.doctor.qualification ? `, ${data.doctor.qualification}` : ''}
            {data.doctor.specialty ? ` (${data.doctor.specialty})` : ''}
          </p>
        )}

        {/* Referral Doctor */}
        {data.referralDoctor && (
          <p className="text-sm mb-3">
            <strong>Referred By:</strong>&ensp;{data.referralDoctor.name}
          </p>
        )}

        {/* Service / Test Table */}
        <table className="w-full table-fixed border-collapse border border-black text-sm mb-4">
          <colgroup>
            <col className="w-[74px]" />
            <col />
            <col className="w-[148px]" />
          </colgroup>
          <thead>
            <tr className="border-b border-black">
              <th className="border-r border-black px-3 py-3 text-left font-bold">S.NO</th>
              <th className="border-r border-black px-3 py-3 text-left font-bold">
                {isDiagnostic ? 'PRODUCT NAME' : 'SERVICE DESCRIPTION'}
              </th>
              <th className="px-3 py-3 text-right font-bold">AMOUNT (₹)</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, index) => (
              <tr key={item.id} className="border-b border-black">
                <td className="border-r border-black px-3 py-3 align-middle">{index + 1}</td>
                <td className="border-r border-black px-3 py-3 align-middle">{item.name}</td>
                <td className="px-3 py-3 text-right align-middle">{item.price.toFixed(2)}</td>
              </tr>
            ))}
            {showSubtotal && (
              <tr>
                <td className="border-r border-black px-3 py-2"></td>
                <td className="border-r border-black px-3 py-2 text-right text-gray-700">SUBTOTAL</td>
                <td className="px-3 py-2 text-right text-gray-700">₹{subtotalAmount.toFixed(2)}</td>
              </tr>
            )}
            {showDiscount && (
              <tr>
                <td className="border-r border-black px-3 py-2"></td>
                <td className="border-r border-black px-3 py-2 text-right text-gray-700">{discountLabel}</td>
                <td className="px-3 py-2 text-right text-gray-700">-₹{discountAmount.toFixed(2)}</td>
              </tr>
            )}
            <tr>
              <td className="border-r border-black px-3 py-2"></td>
              <td className="border-r border-black px-3 py-2 text-right font-bold">{finalTotalLabel}</td>
              <td className="px-3 py-2 text-right font-bold">₹{netAmount.toFixed(2)}</td>
            </tr>
            {showPaid && (
              <tr>
                <td className="border-r border-black px-3 py-2"></td>
                <td className="border-r border-black px-3 py-2 text-right text-gray-700">PAID</td>
                <td className="px-3 py-2 text-right text-gray-700">₹{paidAmount.toFixed(2)}</td>
              </tr>
            )}
            {showDue && (
              <tr>
                <td className="border-r border-black px-3 py-2"></td>
                <td className="border-r border-black px-3 py-2 text-right font-bold">DUE</td>
                <td className="px-3 py-2 text-right font-bold">₹{dueAmount.toFixed(2)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Revisit Note (clinic only, always shown for clinic) */}
        {!isDiagnostic && hasBill && (
          <div className="border border-black p-3 mb-4">
            <p className="text-xs">
              <strong>Note:</strong>{' '}
              <em>
                This receipt is valid for a free revisit within 7 days from the date of issue for the same
                complaint with the same consultant. Please carry this bill for the follow-up visit.
              </em>
            </p>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-black pt-3 text-center">
          <p className="text-sm mb-1">We appreciate your trust in Sobhana.</p>
          <p className="text-xs tracking-wider uppercase">
            * This is a computer generated invoice and does not require a physical signature *
          </p>
        </div>
      </div>
    </div>
  );
};

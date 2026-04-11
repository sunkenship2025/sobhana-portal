import type { BillReceiptData } from '@/types';
import { API_BASE_URL } from '@/lib/api';
import { formatReferralPayout } from '@/lib/referralPayouts';

interface BillReceiptProps {
  data: BillReceiptData;
  /** When true, render as a print-page (for multi-page docs like clinic prescription+bill) */
  asPage?: boolean;
}

/**
 * Shared bill receipt component used by:
 * - ClinicPrescriptionPrint (Page 2)
 * - DiagnosticsNewVisit (inline print)
 * - BillPrintPage (Patient360 reprint)
 */
export const BillReceipt = ({ data, asPage = false }: BillReceiptProps) => {
  const isDiagnostic = data.domain === 'DIAGNOSTICS';
  const hasReferral = data.items.some(
    (item) =>
      item.referralType !== undefined ||
      item.referralPercent !== undefined ||
      item.referralAmountInPaise !== undefined
  );

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

  // Container classes: if asPage, use print-page styling; otherwise standalone print-content
  const containerClass = asPage
    ? 'print-page'
    : 'print-content p-8 bg-white text-black max-w-2xl mx-auto';

  return (
    <div className={containerClass}>

      {/* Logo Header - Centered */}
      <div className="flex justify-center mb-1">
        <img
          src={`${API_BASE_URL}/images/sobhana-clinic-logo.png`}
          alt="Sobhana"
          style={{ height: '60px', objectFit: 'contain' }}
          crossOrigin="anonymous"
        />
      </div>
      {data.branchName && (
        <p className="text-center text-xs tracking-widest uppercase mb-3">{data.branchName}</p>
      )}
      <div className="border-t-2 border-black mb-4"></div>

      {/* Bill Info Row */}
      <div className="flex justify-between text-sm mb-1">
        <div>
          <p><strong>Bill No:</strong>&ensp;{data.billNumber}</p>
          <p><strong>Date:</strong>&ensp;{dateStr}</p>
          {visitTypeService && (
            <p><strong>Visit Type:</strong>&ensp;{visitTypeService}</p>
          )}
        </div>
        <div className="text-right">
          <p><strong>Payment:</strong>&ensp;{data.paymentType}</p>
          <p><strong>Status:</strong>&ensp;{data.paymentStatus}</p>
        </div>
      </div>

      {/* Patient Details Box */}
      <div className="border border-black p-3 my-4">
        <h2 className="font-bold text-sm mb-2">Patient Details</h2>
        <div className="grid grid-cols-2 gap-y-1 text-sm">
          <p><strong>Name:</strong>&ensp;{data.patient.name.toUpperCase()}</p>
          <p><strong>Phone:</strong>&ensp;{data.patient.phone || 'N/A'}</p>
          <p><strong>Age:</strong>&ensp;{data.patient.ageDisplay || `${data.patient.age} years`}</p>
          <p><strong>Gender:</strong>&ensp;{genderFull}</p>
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
      <table className="w-full border-collapse border border-black text-sm mb-4">
        <thead>
          <tr className="border-b border-black">
            <th className="border-r border-black p-2 text-left w-16">S.NO</th>
            <th className="border-r border-black p-2 text-left">
              {isDiagnostic ? 'PRODUCT NAME' : 'SERVICE DESCRIPTION'}
            </th>
            {hasReferral && (
              <th className="border-r border-black p-2 text-right w-24">REF</th>
            )}
            <th className="p-2 text-right w-32">AMOUNT (₹)</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, index) => (
            <tr key={item.id} className="border-b border-black">
              <td className="border-r border-black p-2">{index + 1}</td>
              <td className="border-r border-black p-2">{item.name}</td>
              {hasReferral && (
                <td className="border-r border-black p-2 text-right">
                  {item.referralType || item.referralPercent !== undefined || item.referralAmountInPaise !== undefined
                    ? formatReferralPayout({
                        commissionType: item.referralType,
                        commissionPercent: item.referralPercent,
                        commissionAmountInPaise: item.referralAmountInPaise,
                      })
                    : '—'}
                </td>
              )}
              <td className="p-2 text-right">{item.price.toFixed(2)}</td>
            </tr>
          ))}
          <tr>
            <td className="border-r border-black p-2"></td>
            <td colSpan={hasReferral ? 2 : 1} className="border-r border-black p-2 text-right font-bold">TOTAL</td>
            <td className="p-2 text-right font-bold">₹{data.totalAmount.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      {/* Revisit Note (clinic only, always shown for clinic) */}
      {!isDiagnostic && (
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
  );
};

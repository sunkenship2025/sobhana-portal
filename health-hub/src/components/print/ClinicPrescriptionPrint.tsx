import { formatAgeDisplay } from '@/lib/validation';
import { formatPatientName } from '@/lib/patientDisplay';
import type { ClinicVisitView } from '@/types';
import { BillReceipt } from './BillReceipt';
import { mapClinicVisitViewToReceiptData } from '@/lib/billReceiptMappers';

interface ClinicPrescriptionPrintProps {
  visitView: ClinicVisitView;
  branchName?: string;
  onBillLogoLoadedChange?: (loaded: boolean) => void;
}

export const ClinicPrescriptionPrint = ({
  visitView,
  branchName,
  onBillLogoLoadedChange,
  printMode = "both",
}: ClinicPrescriptionPrintProps & { printMode?: "rx" | "bill" | "both" }) => {
  const { visit, patient, clinicDoctor } = visitView;
  const visitDate = new Date(visit.createdAt);
  const followUpDate = new Date(visitDate);
  const billReceiptData = mapClinicVisitViewToReceiptData(visitView, branchName);
  const patientPhone = billReceiptData.patient.phone;
  const patientAge = patient.ageDisplay?.trim()
    ? patient.ageDisplay
    : typeof patient.age === 'number' && Number.isFinite(patient.age)
      ? formatAgeDisplay(patient)
      : 'N/A';
  const genderLabel = patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other';
  const referenceLabel = visit.hasBill ? 'Bill No' : 'Visit Ref';
  const referenceValue = visit.hasBill
    ? visit.billNumber || visit.visitRef || '—'
    : visit.visitRef || visit.billNumber || '—';
  const serviceName = billReceiptData.items[0]?.name || 'Consultation';

  followUpDate.setDate(followUpDate.getDate() + 7);

  const visitDateTimeStr = `${visitDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })} ${visitDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`.replace(/ (\w{2})$/, '\u00A0$1');

  const followUpDateStr = followUpDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return (
    <div className="print-content bg-white text-black">
      {/* Page 1 aligns to the pre-printed clinic letterhead instead of rendering a digital header. */}
      {printMode !== "bill" && (
        <div className="clinic-rx-page">
          <div className="clinic-rx-sheet">
            <div className="clinic-rx-header">
              <div className="clinic-rx-doctor-block">
                <h1 className="clinic-rx-doctor-name">{clinicDoctor?.name || 'Clinic Doctor'}</h1>
                {clinicDoctor?.qualification ? (
                  <p className="clinic-rx-doctor-meta">{clinicDoctor.qualification}</p>
                ) : (
                  <p className="clinic-rx-doctor-meta clinic-rx-placeholder">Qualification</p>
                )}
                <p className="clinic-rx-doctor-meta">
                  Reg No: {clinicDoctor?.registrationNumber || '________________'}
                </p>
              </div>
            </div>

            <div className="clinic-rx-body">
              <div className="clinic-rx-patient-box">
                <div className="clinic-rx-patient-column">
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">{referenceLabel}</span>
                    <span className="clinic-rx-patient-value">{referenceValue}</span>
                  </div>
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Patient Name</span>
                    <span className="clinic-rx-patient-value clinic-rx-patient-name">{formatPatientName(patient.name, (patient as any).title, true)}</span>
                  </div>
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Age/Sex</span>
                    <span className="clinic-rx-patient-value">{patientAge} / {genderLabel}</span>
                  </div>
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Visit Type</span>
                    <span className="clinic-rx-patient-value">{serviceName}</span>
                  </div>
                </div>

                <div className="clinic-rx-patient-column">
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Date &amp; Time</span>
                    <span className="clinic-rx-patient-value">{visitDateTimeStr}</span>
                  </div>
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Contact No.</span>
                    <span className="clinic-rx-patient-value">{patientPhone}</span>
                  </div>
                  <div className="clinic-rx-patient-row">
                    <span className="clinic-rx-patient-label">Valid Upto</span>
                    <span className="clinic-rx-patient-value">{followUpDateStr}</span>
                  </div>
                </div>
              </div>

              <div className="clinic-rx-vitals-strip">
                <div className="clinic-rx-vitals-grid">
                  {['BP', 'Pulse', 'Wt', 'Temp', 'SPO2'].map((label) => (
                    <div
                      key={label}
                      className={`clinic-rx-vital-field${label === 'SPO2' ? ' clinic-rx-vital-field-wide' : ''}`}
                    >
                      <span className="clinic-rx-vital-label">{label}</span>
                      <span className="clinic-rx-vital-line" aria-hidden="true"></span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="clinic-rx-script">
                <div className="clinic-rx-symbol">℞</div>
                <div className="clinic-rx-writing-area" aria-hidden="true"></div>
              </div>
            </div>

            <div className="clinic-rx-footer-space" aria-hidden="true"></div>
          </div>
        </div>
      )}

      {printMode !== "rx" && (
        <BillReceipt
          asPage
          onLogoLoadedChange={onBillLogoLoadedChange}
          data={billReceiptData}
        />
      )}
    </div>
  );
};

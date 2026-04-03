import { formatAgeDisplay } from '@/lib/validation';
import type { ClinicVisitView } from '@/types';
import { BillReceipt } from './BillReceipt';

interface ClinicPrescriptionPrintProps {
  visitView: ClinicVisitView;
  branchName?: string;
}

export const ClinicPrescriptionPrint = ({ visitView, branchName }: ClinicPrescriptionPrintProps) => {
  const { visit, patient, clinicDoctor } = visitView;
  const visitDate = new Date(visit.createdAt);
  const followUpDate = new Date(visitDate);
  const patientPhone = patient.identifiers.find((identifier) => identifier.type === 'PHONE')?.value || 'N/A';
  const patientAge = formatAgeDisplay(patient);
  const genderLabel = patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other';

  followUpDate.setDate(followUpDate.getDate() + 7);

  const visitDateTimeStr = `${visitDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })} ${visitDate.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;

  const followUpDateStr = followUpDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  const visitTypeService = visit.visitType === 'OP' ? 'OP Consultation' : 'IP Consultation';

  return (
    <div className="print-content bg-white text-black">
      {/* Page 1 aligns to the pre-printed clinic letterhead instead of rendering a digital header. */}
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

            <div className="clinic-rx-vitals-box">
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
          </div>

          <div className="clinic-rx-body">
            <div className="clinic-rx-patient-box">
              <div className="clinic-rx-patient-column">
                <div className="clinic-rx-patient-row">
                  <span className="clinic-rx-patient-label">Bill No</span>
                  <span className="clinic-rx-patient-value">{visit.billNumber}</span>
                </div>
                <div className="clinic-rx-patient-row">
                  <span className="clinic-rx-patient-label">Patient Name</span>
                  <span className="clinic-rx-patient-value">{patient.name.toUpperCase()}</span>
                </div>
                <div className="clinic-rx-patient-row">
                  <span className="clinic-rx-patient-label">Age/Sex</span>
                  <span className="clinic-rx-patient-value">{patientAge} / {genderLabel}</span>
                </div>
              </div>

              <div className="clinic-rx-patient-column clinic-rx-patient-column-right">
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

            <div className="clinic-rx-script">
              <div className="clinic-rx-symbol">℞</div>
              <div className="clinic-rx-writing-area" aria-hidden="true"></div>
            </div>

            <div className="clinic-rx-signature">
              <div className="clinic-rx-signature-line"></div>
              <p className="clinic-rx-signature-label">Doctor&apos;s Signature</p>
            </div>
          </div>

          <div className="clinic-rx-footer-space" aria-hidden="true"></div>
        </div>
      </div>

      <BillReceipt
        asPage
        data={{
          billNumber: visit.billNumber,
          date: visit.createdAt,
          domain: 'CLINIC',
          visitType: visit.visitType,
          isRevisit: visit.isRevisit,
          branchName,
          patient: {
            name: patient.name,
            phone: patientPhone,
            age: patient.age,
            ageDisplay: patient.ageDisplay,
            gender: patient.gender,
          },
          doctor: clinicDoctor
            ? {
                name: clinicDoctor.name,
                qualification: clinicDoctor.qualification,
                specialty: clinicDoctor.specialty,
              }
            : undefined,
          paymentType: visit.paymentType,
          paymentStatus: visit.paymentStatus,
          totalAmount: visit.consultationFeeInPaise / 100,
          items: [
            {
              id: visit.id,
              name: visitTypeService,
              price: visit.consultationFeeInPaise / 100,
            },
          ],
        }}
      />
    </div>
  );
};

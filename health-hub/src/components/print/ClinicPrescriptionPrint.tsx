import type { ClinicVisitView } from '@/types';

interface ClinicPrescriptionPrintProps {
  visitView: ClinicVisitView;
}

export const ClinicPrescriptionPrint = ({ visitView }: ClinicPrescriptionPrintProps) => {
  const { visit, patient, clinicDoctor } = visitView;

  return (
    <div className="print-content p-8 bg-white text-black max-w-2xl mx-auto">
      {/* Letterhead */}
      <div className="border-b-2 border-black pb-4 mb-4 flex justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{clinicDoctor?.name || 'Clinic Doctor'}</h1>
          <p className="text-sm">{clinicDoctor?.qualification}</p>
          <p className="text-sm">{clinicDoctor?.specialty}</p>
          <p className="text-sm">Reg. No: {clinicDoctor?.registrationNumber}</p>
          {clinicDoctor?.phone && <p className="text-sm">Phone: {clinicDoctor.phone}</p>}
        </div>
        <div className="text-right text-sm">
          <p>Clinic Visit Bill</p>
          <p className="font-mono">{visit.billNumber}</p>
          <p>{new Date(visit.createdAt).toLocaleDateString()}</p>
        </div>
      </div>

      {/* Patient Info */}
      <div className="border border-black p-3 mb-4">
        <h2 className="font-bold mb-2">Patient Details</h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <p><strong>Name:</strong> {patient.name}</p>
          <p><strong>Phone:</strong> {patient.identifiers.find(i => i.type === 'PHONE')?.value || 'N/A'}</p>
          <p><strong>Age/Gender:</strong> {patient.age} / {patient.gender}</p>
          <p><strong>Visit Type:</strong> {visit.visitType}</p>
        </div>
      </div>

      {/* Prescription Body (blank for notes) */}
      <div className="border border-black p-4 mb-4 min-h-[240px]">
        <h3 className="font-semibold mb-2">Prescription / Notes</h3>
        <p className="text-sm text-gray-700">(Write instructions here)</p>
      </div>

      {/* Billing */}
      <div className="border border-black p-3 mb-4">
        <div className="flex justify-between text-sm">
          <span>Consultation Fee</span>
          <span className="font-bold">₹{(visit.consultationFeeInPaise / 100).toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span>Payment</span>
          <span>{visit.paymentType} / {visit.paymentStatus}</span>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm mt-6 pt-4 border-t border-black">
        <p>{clinicDoctor?.letterheadNote || 'Thank you for visiting our clinic.'}</p>
        <p className="mt-2">* This is a computer generated document *</p>
      </div>
    </div>
  );
};

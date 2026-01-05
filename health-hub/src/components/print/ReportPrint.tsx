import type { DiagnosticVisitView } from '@/types';

interface ReportPrintProps {
  visitView: DiagnosticVisitView;
}

export const ReportPrint = ({ visitView }: ReportPrintProps) => {
  const { visit, patient, referralDoctor, results } = visitView;
  
  return (
    <div className="print-content p-8 bg-white text-black max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center border-b-2 border-black pb-4 mb-4">
        <h1 className="text-2xl font-bold">DIAGNOSTIC CENTER</h1>
        <p className="text-sm">123 Medical Street, City - 123456</p>
        <p className="text-sm">Phone: 1234567890 | Email: info@diagnostic.com</p>
      </div>

      <h2 className="text-xl font-bold text-center mb-4 uppercase">Laboratory Report</h2>

      {/* Bill Info */}
      <div className="flex justify-between mb-4">
        <div>
          <p><strong>Bill No:</strong> {visit.billNumber}</p>
          <p><strong>Date:</strong> {new Date(visit.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="text-right">
          <p><strong>Status:</strong> {visit.status}</p>
        </div>
      </div>

      {/* Patient Info */}
      <div className="border border-black p-3 mb-6">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <p><strong>Name:</strong> {patient.name}</p>
          <p><strong>Phone:</strong> {patient.identifiers.find(i => i.type === 'PHONE')?.value || 'N/A'}</p>
          <p><strong>Age:</strong> {patient.age} years</p>
          <p><strong>Gender:</strong> {patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other'}</p>
        </div>
      </div>

      {/* Referral Doctor */}
      {referralDoctor && (
        <div className="mb-4">
          <p><strong>Referred By:</strong> {referralDoctor.name}</p>
        </div>
      )}

      {/* Results Table */}
      <table className="w-full border-collapse border border-black mb-6">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black p-2 text-left">Test</th>
            <th className="border border-black p-2 text-right">Value</th>
            <th className="border border-black p-2 text-right">Reference</th>
            <th className="border border-black p-2 text-center">Status</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <tr key={result.id}>
              <td className="border border-black p-2 font-medium">{result.testName}</td>
              <td className="border border-black p-2 text-right font-mono">
                {result.value ?? '—'}
              </td>
              <td className="border border-black p-2 text-right text-sm">
                {result.referenceRange.min > 0 || result.referenceRange.max > 0
                  ? `${result.referenceRange.min}–${result.referenceRange.max} ${result.referenceRange.unit}`
                  : '—'}
              </td>
              <td className={`border border-black p-2 text-center font-bold ${
                result.flag === 'HIGH' || result.flag === 'LOW' ? 'text-red-600' : ''
              }`}>
                {result.flag || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Signature */}
      <div className="flex justify-end mt-12">
        <div className="text-center">
          <div className="border-t border-black pt-2 px-12">
            <p className="font-medium">Authorized Signatory</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm mt-8 pt-4 border-t border-black">
        <p>* This is a computer generated report *</p>
      </div>
    </div>
  );
};

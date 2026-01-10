import type { DiagnosticVisitView } from '@/types';

interface BillPrintProps {
  visitView: DiagnosticVisitView;
}

export const BillPrint = ({ visitView }: BillPrintProps) => {
  const { visit, patient, testOrders, referralDoctor } = visitView;
  const hasReferralCommission = testOrders.some((order) => order.referralCommissionPercent !== undefined);
  
  return (
    <div className="print-content p-8 bg-white text-black max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center border-b-2 border-black pb-4 mb-4">
        <h1 className="text-2xl font-bold">DIAGNOSTIC CENTER</h1>
        <p className="text-sm">123 Medical Street, City - 123456</p>
        <p className="text-sm">Phone: 1234567890 | Email: info@diagnostic.com</p>
      </div>

      {/* Bill Info */}
      <div className="flex justify-between mb-6">
        <div>
          <p><strong>Bill No:</strong> {visit.billNumber}</p>
          <p><strong>Date:</strong> {new Date(visit.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="text-right">
          <p><strong>Payment:</strong> {visit.paymentType}</p>
          <p><strong>Status:</strong> {visit.paymentStatus}</p>
        </div>
      </div>

      {/* Patient Info */}
      <div className="border border-black p-3 mb-6">
        <h2 className="font-bold mb-2">Patient Details</h2>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <p><strong>Name:</strong> {patient.name}</p>
          <p><strong>Phone:</strong> {patient.phone}</p>
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

      {/* Tests Table */}
      <table className="w-full border-collapse border border-black mb-6">
        <thead>
          <tr className="bg-gray-100">
            <th className="border border-black p-2 text-left">S.No</th>
            <th className="border border-black p-2 text-left">Test Name</th>
            {hasReferralCommission && (
              <th className="border border-black p-2 text-right">Ref %</th>
            )}
            <th className="border border-black p-2 text-right">Amount (₹)</th>
          </tr>
        </thead>
        <tbody>
          {testOrders.map((order, index) => (
            <tr key={order.id}>
              <td className="border border-black p-2">{index + 1}</td>
              <td className="border border-black p-2">{order.testName}</td>
              {hasReferralCommission && (
                <td className="border border-black p-2 text-right">
                  {order.referralCommissionPercent !== undefined ? `${order.referralCommissionPercent}%` : '—'}
                </td>
              )}
              <td className="border border-black p-2 text-right">{(order.priceInPaise / 100).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-bold">
            <td colSpan={hasReferralCommission ? 3 : 2} className="border border-black p-2 text-right">Total:</td>
            <td className="border border-black p-2 text-right">₹{(visit.totalAmountInPaise / 100).toLocaleString()}</td>
          </tr>
        </tfoot>
      </table>

      {/* Footer */}
      <div className="text-center text-sm mt-8 pt-4 border-t border-black">
        <p>Thank you for choosing our services!</p>
        <p className="mt-2">* This is a computer generated bill *</p>
      </div>
    </div>
  );
};

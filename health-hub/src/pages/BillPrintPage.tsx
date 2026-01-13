import { useState, useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

const API_BASE = 'http://localhost:3000/api';

interface BillData {
  visit: {
    id: string;
    billNumber: string;
    domain: 'CLINIC' | 'DIAGNOSTICS';
    status: string;
    createdAt: string;
    totalAmount: number;
    visitType?: string;
  };
  patient: {
    name: string;
    age: number;
    gender: string;
    phone: string;
  };
  branch: {
    name: string;
    code: string;
  };
  payment: {
    type: string;
    status: string;
  };
  doctor?: {
    name: string;
    qualification?: string;
  };
  referralDoctor?: {
    name: string;
  };
  items: Array<{
    id: string;
    name: string;
    code: string;
    price: number;
    referralCommissionPercent?: number;
  }>;
}

export default function BillPrintPage() {
  const { domain, visitId } = useParams<{ domain: string; visitId: string }>();
  const { token } = useAuthStore();
  const [billData, setBillData] = useState<BillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (domain && visitId) {
      fetchBillData();
    }
  }, [domain, visitId]);

  const fetchBillData = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${API_BASE}/bills/${domain}/${visitId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Bill not found');
        }
        throw new Error('Failed to fetch bill data');
      }

      const data = await response.json();
      setBillData(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error || !billData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <AlertTriangle className="h-12 w-12 text-destructive" />
        <p className="text-lg font-medium">Failed to load bill</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => window.close()}>
          Close Window
        </Button>
      </div>
    );
  }

  const isDiagnostic = billData.visit.domain === 'DIAGNOSTICS';
  const hasReferralCommission = billData.items.some((item) => item.referralCommissionPercent !== undefined);

  return (
    <>
      {/* Print Button (hidden on print) */}
      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={() => window.print()}>
          Print Bill
        </Button>
      </div>

      {/* Bill Content */}
      <div className="print-content p-8 bg-white text-black max-w-2xl mx-auto">
        {/* Header */}
        <div className="text-center border-b-2 border-black pb-4 mb-4">
          <h1 className="text-2xl font-bold">
            {isDiagnostic ? 'DIAGNOSTIC CENTER' : 'MEDICAL CLINIC'}
          </h1>
          <p className="text-sm">{billData.branch.name}</p>
          <p className="text-sm">Thank you for choosing our services</p>
        </div>

        {/* Bill Info */}
        <div className="flex justify-between mb-6">
          <div>
            <p><strong>Bill No:</strong> {billData.visit.billNumber}</p>
            <p><strong>Date:</strong> {new Date(billData.visit.createdAt).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}</p>
          </div>
          <div className="text-right">
            <p><strong>Payment:</strong> {billData.payment.type}</p>
            <p><strong>Status:</strong> {billData.payment.status}</p>
          </div>
        </div>

        {/* Patient Info */}
        <div className="border border-black p-3 mb-6">
          <h2 className="font-bold mb-2">Patient Details</h2>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <p><strong>Name:</strong> {billData.patient.name}</p>
            <p><strong>Phone:</strong> {billData.patient.phone}</p>
            <p><strong>Age:</strong> {billData.patient.age} years</p>
            <p><strong>Gender:</strong> {billData.patient.gender === 'M' ? 'Male' : billData.patient.gender === 'F' ? 'Female' : 'Other'}</p>
          </div>
        </div>

        {/* Doctor Info */}
        {billData.doctor && (
          <div className="mb-4">
            <p><strong>Consulting Doctor:</strong> {billData.doctor.name}{billData.doctor.qualification ? `, ${billData.doctor.qualification}` : ''}</p>
          </div>
        )}

        {/* Referral Doctor */}
        {billData.referralDoctor && (
          <div className="mb-4">
            <p><strong>Referred By:</strong> {billData.referralDoctor.name}</p>
          </div>
        )}

        {/* Items Table */}
        <table className="w-full border-collapse border border-black mb-6">
          <thead>
            <tr className="bg-gray-100">
              <th className="border border-black p-2 text-left">S.No</th>
              <th className="border border-black p-2 text-left">
                {isDiagnostic ? 'Test Name' : 'Service'}
              </th>
              {hasReferralCommission && (
                <th className="border border-black p-2 text-right">Ref %</th>
              )}
              <th className="border border-black p-2 text-right">Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {billData.items.map((item, index) => (
              <tr key={item.id}>
                <td className="border border-black p-2">{index + 1}</td>
                <td className="border border-black p-2">{item.name}</td>
                {hasReferralCommission && (
                  <td className="border border-black p-2 text-right">
                    {item.referralCommissionPercent !== undefined ? `${item.referralCommissionPercent}%` : '—'}
                  </td>
                )}
                <td className="border border-black p-2 text-right">{item.price.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td colSpan={hasReferralCommission ? 3 : 2} className="border border-black p-2 text-right">Total:</td>
              <td className="border border-black p-2 text-right">₹{billData.visit.totalAmount.toLocaleString('en-IN')}</td>
            </tr>
          </tfoot>
        </table>

        {/* Footer */}
        <div className="text-center text-sm mt-8 pt-4 border-t border-black">
          <p>Thank you for your business!</p>
          <p className="mt-2">* This is a computer generated bill *</p>
        </div>
      </div>

      <style>{`
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            margin: 0;
            padding: 0;
          }
          .print-content {
            max-width: 100%;
          }
        }
      `}</style>
    </>
  );
}

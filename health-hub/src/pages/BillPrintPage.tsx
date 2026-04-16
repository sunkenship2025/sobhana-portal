import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { API_BASE } from '@/lib/api';
import { BillReceipt } from '@/components/print/BillReceipt';
import type { BillReceiptData } from '@/types';

// Shape returned by GET /api/bills/:domain/:visitId
interface ApiBillData {
  visit: {
    id: string;
    visitRef?: string;
    billNumber?: string | null;
    hasBill?: boolean;
    domain: 'CLINIC' | 'DIAGNOSTICS';
    status: string;
    createdAt: string;
    totalAmount: number;
    visitType?: string;
    isRevisit?: boolean;
    originalVisitBillNumber?: string | null;
    originalVisitDate?: string | null;
  };
  patient: {
    name: string;
    age: number;
    ageDisplay?: string;
    gender: string;
    phone: string;
  };
  branch: {
    name: string;
    code: string;
  };
  payment: {
    type?: string | null;
    status?: string | null;
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
    referralCommissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
    referralCommissionPercent?: number;
    referralCommissionAmountInPaise?: number;
  }>;
}

/** Transform API response → shared BillReceiptData */
function toBillReceiptData(api: ApiBillData): BillReceiptData {
  return {
    visitRef: api.visit.visitRef,
    billNumber: api.visit.billNumber,
    hasBill: api.visit.hasBill,
    date: api.visit.createdAt,
    domain: api.visit.domain,
    visitType: api.visit.visitType,
    isRevisit: api.visit.isRevisit,
    originalBillNumber: api.visit.originalVisitBillNumber,
    originalVisitDate: api.visit.originalVisitDate,
    branchName: api.branch.name,
    patient: {
      name: api.patient.name,
      phone: api.patient.phone,
      age: api.patient.age,
      ageDisplay: api.patient.ageDisplay,
      gender: api.patient.gender,
    },
    doctor: api.doctor,
    referralDoctor: api.referralDoctor,
    paymentType: api.payment.type,
    paymentStatus: api.payment.status,
    totalAmount: api.visit.totalAmount,
    items: api.items.map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      referralType: item.referralCommissionType,
      referralPercent: item.referralCommissionPercent,
      referralAmountInPaise: item.referralCommissionAmountInPaise,
    })),
  };
}

export default function BillPrintPage() {
  const { domain, visitId } = useParams<{ domain: string; visitId: string }>();
  const { token } = useAuthStore();
  const [billData, setBillData] = useState<ApiBillData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const printLabel = billData?.visit.hasBill === false ? 'Print Visit Slip' : 'Print Bill';

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
        <p className="text-lg font-medium">Failed to load print document</p>
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => window.close()}>
          Close Window
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Print Button (hidden on print) */}
      <div className="no-print fixed top-4 right-4 z-50">
        <Button onClick={() => window.print()}>
          {printLabel}
        </Button>
      </div>

      {/* Bill Content — shared component */}
      <BillReceipt data={toBillReceiptData(billData)} />
    </>
  );
}

/**
 * Owner Money — day sheet (per-bill register). Types only.
 *
 * The HTML used to be built here. It now lives in the backend
 * (daySheetHtmlService) because the public token link has to render the same
 * document for someone who is not signed in — and two renderers of one money
 * document would drift. The print button asks for ?format=html.
 */

export interface DaySheetRow {
  billNumber: string;
  billedAtIso: string;
  patientName: string;
  patientTitle: string | null;
  branchCode: string;
  referredBy: string | null;
  domain: 'DIAGNOSTICS' | 'CLINIC';
  tests: string;
  testCount: number;
  grossInPaise: number;
  discountInPaise: number;
  paidInPaise: number;
  cashInPaise: number;
  onlineInPaise: number;
  dueInPaise: number;
  refundedInPaise: number;
  paymentMethod: 'CASH' | 'ONLINE' | 'MIXED' | 'NONE';
  paymentStatus: string;
}

export interface DaySheetResponse {
  generatedAt: string;
  period: { key: string; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  domain: 'ALL' | 'DIAGNOSTICS' | 'CLINIC';
  rows: DaySheetRow[];
  totals: {
    count: number;
    grossInPaise: number;
    discountInPaise: number;
    paidInPaise: number;
    cashInPaise: number;
    onlineInPaise: number;
    dueInPaise: number;
    refundedInPaise: number;
  };
}


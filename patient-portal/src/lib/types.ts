// Mirrors the /api/patient responses (health-hub-backend/src/routes/patientPortal.ts).

export interface Profile {
  patientId: string;
  patientNumber: string;
  name: string;
  gender: string | null;
  age: string | null;
}

export interface BillInfo {
  hasBill: boolean;
  billNumber: string | null;
  totalInPaise: number;
  paidInPaise: number;
  dueInPaise: number;
}

export interface ReportItem {
  /** Server-side gate: READY and not withdrawn. Absent = do not offer it. */
  hasSmartReport?: boolean;
  visitId: string;
  reportVersionId: string;
  date: string;
  branch: string;
  tests: string;
  isNew: boolean;
  bill: BillInfo;
}

export interface AwaitingItem {
  visitId: string;
  date: string;
  branch: string;
  tests: string;
  bill: BillInfo;
}

export interface OnTheWayItem {
  visitId: string;
  date: string;
  branch: string;
  tests: string;
}

export interface OverviewProfile extends Profile {
  reports: ReportItem[];
  awaitingPayment: AwaitingItem[];
  onTheWay: OnTheWayItem[];
}

export interface OverviewResponse {
  phone: string;
  profiles: OverviewProfile[];
}

export interface MeResponse {
  phone: string;
  profiles: Profile[];
}

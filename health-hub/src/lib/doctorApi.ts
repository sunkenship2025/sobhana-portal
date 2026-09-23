/**
 * Doctor-portal API client + types.
 *
 * Hand-mirrors the backend shapes, like the rest of `api.ts` does. The frontend
 * build strips types WITHOUT checking them (`vite build` does not typecheck), so
 * these can drift silently — run `tsc --noEmit` before shipping, always.
 */
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PrescriptionStatus = 'DRAFT' | 'SIGNED' | 'SUPERSEDED';
export type MedicationResolution = 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'MANUAL';
export type FieldState = 'SPOKEN' | 'NORMALIZED' | 'UNKNOWN';
export type Severity = 'BLOCK' | 'ASK' | 'NOTE';

export const FREQUENCY_OPTIONS = [
  { code: 'OD', label: 'Once daily' },
  { code: 'BD', label: 'Twice daily' },
  { code: 'TID', label: 'Three times a day' },
  { code: 'QID', label: 'Four times a day' },
  { code: 'HS', label: 'At bedtime' },
  { code: 'SOS', label: 'As needed' },
  { code: 'STAT', label: 'Immediately, single dose' },
  { code: 'WEEKLY', label: 'Once weekly' },
  { code: 'ALT_DAY', label: 'Every other day' },
  { code: 'QH', label: 'Hourly' },
] as const;

export const TIMING_OPTIONS = ['before food', 'after food', 'with food', 'empty stomach', 'bedtime'] as const;
export const ROUTE_OPTIONS = ['oral', 'topical', 'IV', 'IM', 'SC', 'ophthalmic', 'otic', 'nasal', 'inhalation', 'vaginal', 'rectal'] as const;
export const DURATION_UNITS = ['days', 'weeks', 'months'] as const;

export interface MedicationCandidate {
  medicationId: string;
  canonicalName: string;
  genericName: string | null;
  brandName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  route: string | null;
  score: number;
  matchedOn: 'exact' | 'alias' | 'phonetic' | 'fuzzy';
}

export interface RxItem {
  id?: string;
  displayOrder?: number;
  spokenText: string | null;
  medicationId: string | null;
  canonicalName: string;
  genericName: string | null;
  brandName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  doseQty: string | null;
  doseUnit: string | null;
  frequencyCode: string | null;
  frequencyText: string | null;
  route: string | null;
  timing: string | null;
  durationValue: number | null;
  durationUnit: string | null;
  instructions: string | null;
  resolution: MedicationResolution;
  candidates: MedicationCandidate[] | null;
  fieldStates: Record<string, FieldState | boolean> | null;
  sourceText: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
}

export interface Prescription {
  id: string;
  visitId: string;
  clinicDoctorId: string;
  branchId: string;
  rootId: string;
  version: number;
  isLatest: boolean;
  previousVersionId: string | null;
  revisionReason: string | null;
  status: PrescriptionStatus;
  diagnosis: string | null;
  notes: string | null;
  followUpDays: number | null;
  signedAt: string | null;
  signedByUserId: string | null;
  snapshot: PrescriptionSnapshot | null;
  transcript: string | null;
  transcriptSegments: TranscriptSegment[] | null;
  asrProvider: string | null;
  asrModel: string | null;
  extractionModel: string | null;
  createdAt: string;
  updatedAt: string;
  items: RxItem[];
  clinicDoctor: { id: string; name: string; qualification: string; specialty: string; registrationNumber: string };
  visitCompleted?: boolean;
}

export interface PrescriptionSnapshot {
  doctor: {
    name: string; qualification: string; specialty: string;
    registrationNumber: string; letterheadNote: string | null; signatureImageBase64: string | null;
  };
  branch: { id: string; name: string; address: string | null; phone: string | null };
  patient: { id: string; patientNumber: string; name: string; title: string | null; ageLabel: string; gender: string; phone: string | null };
  visit: { id: string; visitType: string | null; tokenNumber: number | null; date: string };
  signedAt: string;
}

export interface TranscriptSegment { text: string; start: number; end: number }

export interface Finding { severity: Severity; code: string; message: string; itemId?: string; field?: string }
export interface ValidationResult { findings: Finding[]; canSign: boolean }

export interface QueueRow {
  clinicVisitId: string;
  visitId: string;
  visitType: 'OP' | 'IP';
  ward: string | null;
  status: 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';
  tokenNumber: number | null;
  isRevisit: boolean;
  waitingSince: string;
  startedAt: string | null;
  completedAt: string | null;
  doctorName: string;
  patient: { id: string; patientNumber: string; name: string; title: string | null; gender: string; ageLabel: string; deceased: boolean };
  prescription: { id: string; status: PrescriptionStatus } | null;
}

export interface DoctorMe {
  doctor: {
    id: string; doctorNumber: string; name: string; qualification: string; specialty: string;
    registrationNumber: string; phone: string | null; email: string | null;
    letterheadNote: string | null; signatureImageBase64: string | null; hprId: string | null;
  } | null;
  diagnosticsVisible: boolean;
  branch: { id: string };
}

export interface DraftRow {
  id: string;
  createdAt: string;
  visitId: string;
  items: { canonicalName: string; resolution: MedicationResolution }[];
  visit: { id: string; patient: { name: string; patientNumber: string } };
}

export interface ExtractionResponse {
  transcript: { text: string; segments: TranscriptSegment[]; language: string | null; provider: string; model: string; durationSec: number | null };
  extraction: {
    items: ExtractedItem[];
    diagnosis: string | null;
    notes: string | null;
    followUpDays: number | null;
    /** What was expected but NOT said. Omissions are the class nobody catches. */
    missing: string[];
    model: string;
  };
  tookMs: number;
}

export interface ExtractedItem {
  spokenText: string;
  name: string;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  doseQty: string | null;
  doseUnit: string | null;
  frequencyCode: string | null;
  frequencyText: string | null;
  route: string | null;
  timing: string | null;
  durationValue: number | null;
  durationUnit: string | null;
  instructions: string | null;
  fieldStates: Record<string, FieldState>;
  sourceText: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  isAlternative: boolean;
}

export interface DoctorPatient {
  patient: { id: string; patientNumber: string; name: string; title: string | null; gender: string; ageLabel: string; phone: string | null; deceased: boolean; deceasedAt: string | null };
  glance: { lastConsultation: string | null; lastConsultationDoctor: string | null; consultations: number; prescriptions: number; currentlyOn: number };
  currentMedications: { name: string; since: string }[];
  timeline: {
    visitId: string; domain: string; status: string; date: string; branchName: string;
    visitType: string | null; ward: string | null; doctorName: string | null;
    prescriptionId: string | null; tests?: string[];
  }[];
  prescriptions: {
    id: string; signedAt: string | null; visitId: string; diagnosis: string | null; followUpDays: number | null;
    items: Pick<RxItem, 'canonicalName' | 'strength' | 'strengthUnit' | 'doseQty' | 'doseUnit' | 'frequencyCode' | 'frequencyText' | 'timing' | 'durationValue' | 'durationUnit'>[];
    clinicDoctor: { name: string };
  }[];
  diagnosticsVisible: boolean;
  breakGlass: boolean;
}

export interface Capabilities {
  asr: { name: string; configured: boolean; model: string }[];
  asrConfigured: boolean;
  extractionConfigured: boolean;
  voiceEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/** Error bodies this API returns. Typed rather than `any` so callers read fields safely. */
export interface ApiErrorBody {
  error?: string;
  message?: string;
  patient?: { name?: string; patientNumber?: string };
  detail?: string;
}

export class DoctorApiError extends Error {
  constructor(public status: number, message: string, public body?: ApiErrorBody) {
    super(message);
  }
}

function headers(json = true): Record<string, string> {
  const token = useAuthStore.getState().token;
  const branchId = useBranchStore.getState().getActiveBranch()?.id;
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (branchId) h['X-Branch-Id'] = branchId;
  return h;
}

async function req<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: { ...headers(json !== undefined || rest.method === undefined), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    throw new DoctorApiError(res.status, body?.message || `Request failed (${res.status})`, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const doctorApi = {
  me: () => req<DoctorMe>('/doctor/me'),
  updateMe: (patch: { signatureImageBase64?: string | null; letterheadNote?: string }) =>
    req<DoctorMe['doctor']>('/doctor/me', { method: 'PATCH', json: patch }),

  queue: () => req<{ queue: QueueRow[]; counts: { waiting: number; inProgress: number; doneToday: number } }>('/doctor/queue'),
  callNext: () => req<{ visitId: string; clinicVisitId: string }>('/doctor/queue/next', { method: 'POST', json: {} }),
  setVisitStatus: (visitId: string, status: 'IN_PROGRESS' | 'COMPLETED') =>
    req<{ ok: true; status: string }>(`/doctor/queue/${visitId}`, { method: 'PATCH', json: { status } }),

  searchPatients: (q: string) =>
    req<{ id: string; patientNumber: string; name: string; title: string | null; gender: string; ageLabel: string; deceased: boolean; myPatient: boolean }[]>(
      `/doctor/patients?q=${encodeURIComponent(q)}`,
    ),
  patient: (id: string, reason?: string) =>
    req<DoctorPatient>(`/doctor/patients/${id}${reason ? `?reason=${encodeURIComponent(reason)}` : ''}`),

  capabilities: () => req<Capabilities>('/prescriptions/capabilities'),
  drafts: () => req<DraftRow[]>('/prescriptions/drafts'),
  /**
   * `mode: 'search'` browses the catalogue as the doctor types (ranked by how
   * literally the text matches). Omitting it RESOLVES — "what did they mean" —
   * which is what dictation needs. Two different questions, one endpoint.
   */
  searchMedications: (q: string, mode?: 'search') =>
    req<{ resolution: MedicationResolution; match: MedicationCandidate | null; candidates: MedicationCandidate[] }>(
      `/prescriptions/medications?q=${encodeURIComponent(q)}${mode ? `&mode=${mode}` : ''}`,
    ),

  /** Audio -> transcript -> structured proposal. Persists NOTHING. */
  transcribe: async (audio: Blob, provider?: string): Promise<ExtractionResponse> => {
    const form = new FormData();
    form.append('audio', audio, 'consultation.webm');
    if (provider) form.append('provider', provider);
    const res = await fetch(`${API_BASE}/prescriptions/transcribe`, {
      method: 'POST',
      credentials: 'include',
      headers: headers(false),
      body: form,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new DoctorApiError(res.status, body?.message || 'Transcription failed', body);
    return body as ExtractionResponse;
  },

  forVisit: (visitId: string) => req<Prescription[]>(`/prescriptions?visitId=${encodeURIComponent(visitId)}`),
  get: (id: string) => req<Prescription>(`/prescriptions/${id}`),
  create: (payload: Record<string, unknown>) => req<Prescription>('/prescriptions', { method: 'POST', json: payload }),
  update: (id: string, patch: Record<string, unknown>) => req<Prescription>(`/prescriptions/${id}`, { method: 'PATCH', json: patch }),
  validate: (id: string) => req<ValidationResult>(`/prescriptions/${id}/validate`),
  sign: (id: string, completeVisit: boolean) =>
    req<Prescription>(`/prescriptions/${id}/sign`, { method: 'POST', json: { completeVisit } }),
  amend: (id: string, reason: string) => req<Prescription>(`/prescriptions/${id}/amend`, { method: 'POST', json: { reason } }),
  discard: (id: string) => req<{ ok: true }>(`/prescriptions/${id}`, { method: 'DELETE' }),
};

// ---------------------------------------------------------------------------
// Display helpers — one source of truth for how a line reads
// ---------------------------------------------------------------------------

/** "Amlodipine 5 mg" — name plus strength, never truncated. */
export function itemTitle(it: Pick<RxItem, 'canonicalName' | 'strength' | 'strengthUnit'>): string {
  if (!it.strength) return it.canonicalName;
  // Don't repeat a strength the canonical name already carries.
  if (it.canonicalName.includes(it.strength)) return it.canonicalName;
  return `${it.canonicalName} ${it.strength}${it.strengthUnit ?? ''}`.trim();
}

/** "1 tablet · three times a day · after food · 5 days" */
export function itemSig(it: RxItem): string {
  const parts: string[] = [];
  if (it.doseQty) parts.push(`${it.doseQty} ${it.doseUnit ?? (it.dosageForm ?? '')}`.trim());
  if (it.frequencyText || it.frequencyCode) {
    parts.push(it.frequencyText ?? FREQUENCY_OPTIONS.find((f) => f.code === it.frequencyCode)?.label ?? it.frequencyCode!);
  }
  if (it.timing) parts.push(it.timing);
  if (it.durationValue != null) parts.push(`${it.durationValue} ${it.durationUnit ?? 'days'}`);
  return parts.join(' · ');
}

/** Absence is a value. "Not stated" is rendered, never silently filled. */
export function isUnknown(it: RxItem, field: string): boolean {
  return it.fieldStates?.[field] === 'UNKNOWN';
}

export const isBlocking = (f: Finding) => f.severity === 'BLOCK' || f.severity === 'ASK';

/**
 * The typed edge between the Automations screens and /api/automations.
 *
 * Every number the screens show comes from here. Nothing is recomputed in React: who
 * qualifies, who would be messaged today and why someone was skipped are all answered
 * by the same code the sender uses, so the preview can never promise something the
 * engine would refuse.
 */
import { apiRequest } from '@/lib/utils';
import { API_BASE } from '@/lib/api';

export { REASON_LABEL, reasonLabel, vocabOf, type Vocab } from './reasons';

const AUT = `${API_BASE}/automations`;
const OFF = `${API_BASE}/offers`;

// ── Definition ──────────────────────────────────────────────────────────────

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fn: string; args?: Record<string, unknown>; op?: Op; value?: unknown; unit?: string };

export type ParamBinding =
  | { from: 'PATIENT_FIRST_NAME' }
  | { from: 'BRANCH_NAME' }
  | { from: 'COUPON_CODE' }
  | { from: 'LITERAL'; value: string };

/** Who a message is addressed to. Shared by every sending action — see spec §9.12. */
export type Recipients =
  | { kind: 'RUN_PATIENT' }
  | { kind: 'USERS'; userIds?: string[]; role?: 'owner' | 'lab_incharge' | 'staff' | 'sales' };

/**
 * MIRRORS health-hub-backend/src/services/automations/types.ts.
 *
 * It did not, and that is how ASK and HANDOFF came to be rendered by screens whose
 * Step type had never heard of them: every branch narrowed to `never`, the property
 * accesses were errors, and Vite strips types without checking so it shipped and ran.
 * A union that is missing a kind the engine runs is worse than no types at all — it
 * reports success on the exact steps that carry the branching.
 */
export type Step =
  | { kind: 'WAIT'; anchor: 'TRIGGER' | 'PREVIOUS'; days?: number; hours?: number }
  | {
      kind: 'CHECK'; condition: Condition;
      /** 'STOP' ends it, 'CONTINUE' falls through, a number jumps to that step. */
      onTrue: 'STOP' | 'CONTINUE' | number;
      onFalse?: 'STOP' | 'CONTINUE' | number;
      stopReason?: string;
    }
  | {
      kind: 'SEND'; to?: Recipients; template: string; language?: string;
      params: ParamBinding[]; intent: 'REACTIVE' | 'PROACTIVE';
      issueOffer?: {
        campaignId: string;
        /** TRIGGER = claiming late means less time, not a fresh window. */
        expiry?: { anchor: 'TRIGGER' | 'ISSUE'; days: number; endOfDayIST?: boolean };
      };
    }
  | {
      /** A menu, not a conversation. Buttons carry the run id. */
      kind: 'ASK'; template: string; language?: string; params: ParamBinding[];
      intent: 'REACTIVE' | 'PROACTIVE';
      buttons: { payload: string; label: string; goTo: number | 'STOP'; stopReason?: string }[];
      keywords?: { match: string; goTo: number | 'STOP'; stopReason?: string }[];
      /** They replied and nothing matched. */
      onUnmatched: 'HANDOFF' | 'STOP' | 'CONTINUE';
      /** They never replied — a DIFFERENT question from onUnmatched. */
      onNoReply?: 'STOP' | 'CONTINUE' | number;
      waitHours?: number;
    }
  | { kind: 'HANDOFF'; note?: string }
  /**
   * The nightly day sheet. Everything optional here was a constant in the source until
   * it turned out each one is a thing a centre needs to change without a deploy.
   */
  | {
      kind: 'DAY_SHEET';
      domain: 'DIAGNOSTICS' | 'CLINIC';
      to?: Recipients;
      template?: string;
      linkExpiryHours?: number;
    }
  | { kind: 'STOP'; reason: string };

/** Anywhere a branch can point. */
export type Jump = 'STOP' | 'CONTINUE' | number;

export interface AutomationDefinition {
  trigger: { kind: 'VISIT_COMPLETED'; domain: 'CLINIC' | 'DIAGNOSTICS' }
    | { kind: 'REPORT_FINALIZED' }
    /** graceHours belongs to the schedule, not to whatever it then does. */
    | { kind: 'SCHEDULE'; everyDayAtMinutes: number; graceHours?: number };
  reentry: {
    mode: 'PER_EVENT' | 'ONCE' | 'EVERY_N_DAYS'; days?: number;
    concurrency: 'ALLOW_PARALLEL' | 'ONE_ACTIVE_PER_PATIENT';
  };
  audience: Condition;
  goal: { condition: Condition; windowDays: number; stopReason?: string };
  steps: Step[];
}

export interface AutomationRow {
  id: string; key: string; name: string; group: string;
  enabled: boolean; version: number; activatedAt: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
  messageCount: number; days: number[]; runs: number; live: number;
  /** A scheduled report is a different kind of thing from a patient journey. */
  kind: 'SCHEDULE' | 'JOURNEY';
  everyDayAtMinutes: number | null;
}

export interface Automation {
  id: string; key: string; name: string; group: string;
  definition: AutomationDefinition;
  version: number; enabled: boolean; activatedAt: string | null;
  holdoutPct: number; priority: number; branchIds: string[];
}

// ── Reads ───────────────────────────────────────────────────────────────────

export const listAutomations = () =>
  apiRequest<{ automations: AutomationRow[] }>(AUT);

export const getAutomation = (id: string) => apiRequest<Automation>(`${AUT}/${id}`);

export interface TemplateSummary {
  name: string; language: string; category: string; status: string;
  bodyText: string; paramCount: number; hasHeaderMedia: boolean;
}
export const listTemplates = () =>
  apiRequest<{ templates: TemplateSummary[] }>(`${AUT}/templates`);

export interface PreviewRow {
  visitId: string; patientId: string; patientName: string; patientNumber: string;
  branchName: string; visitAt: string;
  whyQualifies: { fn: string; fact: unknown; op?: string; value?: unknown; passed: boolean }[];
  todayOutcome: string;
}
export interface Preview {
  qualifyingVisits: number; uniquePatients: number; wouldSendToday: number;
  breakdown: Record<string, number>; rows: PreviewRow[];
}
export const previewAutomation = (id: string, limit = 20) =>
  apiRequest<Preview>(`${AUT}/${id}/preview?limit=${limit}`);

export interface SimulatedStep {
  day: number; at: string; kind: string; outcome: string; detail?: unknown;
}
/** What you can make happen on the fake clock. REPLIED is what makes a branch walkable. */
export interface SimulatedEvent {
  onDay: number;
  kind: 'DIAGNOSTICS_DONE' | 'REPLIED';
  /** For REPLIED: the button payload she tapped. Absent = she typed something else. */
  payload?: string;
  valueInPaise?: number;
}

export const simulateAutomation = (
  id: string,
  body: { visitId: string; patientId?: string; events: SimulatedEvent[] },
) => apiRequest<{ steps: SimulatedStep[] }>(`${AUT}/${id}/simulate`, {
  method: 'POST', body: JSON.stringify(body),
});

/** Nights, for a scheduled report. No audience, no control group, nothing to convert. */
export interface ScheduledResults {
  kind: 'SCHEDULE';
  version: number;
  nights: {
    night: string; sent: number; failed: number; handedOver: number;
    branches: { branch: string; outcome: string; at: string }[];
  }[];
  totals: { nightsRecorded: number; sent: number; failed: number; handedOver: number };
}

export interface Results {
  kind?: 'JOURNEY';
  version: number; windowDays: number;
  goal: AutomationDefinition['goal'];
  counts: {
    runs: number; uniquePatients: number; treated: number; held: number;
    /** Patients, not messages. */
    messaged: number; delivered: number; read: number;
    waiting: number; live: number; ended: number;
  };
  converted: { treated: number; held: number; beforeMessage: number; afterMessage: number };
  rates: {
    treatedPct: number; heldPct: number; afterMessagePct: number | null;
    /** Null without a control group — there is nothing to subtract. */
    liftPts: number | null; liftMarginPts: number | null; basis: string;
  };
  skipped: { reason: string; count: number }[];
  money: {
    couponsRedeemed: number; discountGivenInPaise: number; incrementalPatients: number | null;
    /** Always null. Meta bills per conversation and no pricing data is ingested. */
    messageCostInPaise: number | null; messageCostNote: string;
  };
  branchSplit: { sameBranch: number; otherBranch: number };
}
export const getResults = (id: string) =>
  apiRequest<Results | ScheduledResults>(`${AUT}/${id}/results`);

export interface ActivityRow {
  id: string; at: string; kind: string; outcome: string; stepIndex: number;
  detail: unknown; runId: string; automation: string; version: number;
  patient: { id: string; name: string; patientNumber: string } | null;
}
export const getActivity = (q: {
  automationId?: string; outcome?: string; patientId?: string; branchId?: string;
  days?: number; cursor?: string; limit?: number;
}) => {
  const p = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => { if (v !== undefined && v !== '') p.set(k, String(v)); });
  return apiRequest<{ rows: ActivityRow[]; nextCursor: string | null }>(`${AUT}/activity?${p}`);
};
export const getActivityReasons = () =>
  apiRequest<{ reasons: { outcome: string; count: number }[] }>(`${AUT}/activity/reasons`);

export interface RunDetail {
  id: string; automationId: string; version: number;
  subjectType: string; subjectId: string; patientId: string | null; branchId: string | null;
  state: string; stopReason: string | null; holdout: boolean; stepIndex: number;
  triggeredAt: string; nextActionAt: string | null;
  convertedAt: string | null; convertedBranchId: string | null; convertedValueInPaise: number | null;
  automation: { name: string; key: string };
  whyEntered: { fn: string; fact: unknown; op?: string; value?: unknown; passed: boolean }[] | null;
  whyStopped: string | null;
  next: { at: string | null; kind: string; stepIndex: number } | null;
  timeline: { at: string; kind: string; outcome: string; stepIndex: number; detail: unknown }[];
}
export const getRun = (runId: string) => apiRequest<RunDetail>(`${AUT}/runs/${runId}`);
export const stopRun = (runId: string) =>
  apiRequest<{ stopped: boolean }>(`${AUT}/runs/${runId}/stop`, { method: 'POST' });

export interface PatientAutomations {
  runs: {
    id: string; automation: string; visitId: string | null; state: string;
    stopReason: string | null; holdout: boolean; version: number;
    messagesSent: number; nextActionAt: string | null;
    convertedAt: string | null; convertedValueInPaise: number | null;
  }[];
  coupons: {
    id: string; code: string; status: string; expiresAt: string; createdAt: string;
    issuedVisitId: string | null; redeemedVisitId: string | null; automationRunId: string | null;
    campaign: { name: string; discountPercentage: number | null; scope: string; maxDiscountPerBillInPaise: number | null };
  }[];
}
export const getPatientAutomations = (patientId: string) =>
  apiRequest<PatientAutomations>(`${AUT}/patients/${patientId}`);

export interface Consent {
  phone: string | null;
  service: { on: boolean; since: string | null };
  marketing: {
    on: boolean; since: string | null; source: string | null;
    blockedByPhoneOptOut: boolean; optedOutAt: string | null; optedOutSource: string | null;
    /** False when the patient replied STOP — only they can lift it, by replying START. */
    staffCanReEnable: boolean;
  };
  deceasedAt: string | null;
  phoneSharedWithPatients: number;
}
export const getConsent = (patientId: string) => apiRequest<Consent>(`${AUT}/consent/${patientId}`);
export const setConsent = (patientId: string, marketingOptIn: boolean, reason?: string) =>
  apiRequest<{ ok: true }>(`${AUT}/consent/${patientId}`, {
    method: 'PUT', body: JSON.stringify({ marketingOptIn, reason }),
  });

// ── Writes ──────────────────────────────────────────────────────────────────

export const saveAutomation = (id: string, body: {
  definition: AutomationDefinition; name?: string; holdoutPct?: number;
  priority?: number; branchIds?: string[];
}) => apiRequest<Automation>(`${AUT}/${id}`, { method: 'PUT', body: JSON.stringify(body) });

export const createAutomation = (body: {
  key: string; name: string; group?: string; definition: AutomationDefinition; holdoutPct?: number;
}) => apiRequest<Automation>(AUT, { method: 'POST', body: JSON.stringify(body) });

export const activateAutomation = (id: string) =>
  apiRequest<Automation>(`${AUT}/${id}/activate`, { method: 'POST' });
export const pauseAutomation = (id: string) =>
  apiRequest<Automation>(`${AUT}/${id}/pause`, { method: 'POST' });
export const stopAutomation = (id: string) =>
  apiRequest<{ runsCancelled: number }>(`${AUT}/${id}/stop`, { method: 'POST' });

// ── Offers ──────────────────────────────────────────────────────────────────

export interface OfferRow {
  id: string; code: string; name: string; isActive: boolean;
  discountPercentage: number | null; scope: string; validityDays: number;
  distribution: string; bindToPatient: boolean; referrerSharePct: number;
  issued: number; redeemed: number; expired: number; voided: number; pending: number;
  budget: {
    maxDiscountBudgetInPaise: number | null; maxDiscountPerBillInPaise: number | null;
    maxRedemptions: number | null; reservedInPaise: number; committedInPaise: number;
    exhausted: boolean;
  };
}
export const listOffers = () => apiRequest<{ offers: OfferRow[] }>(OFF);

export interface ReferralExample {
  billInPaise: number; discountInPaise: number; doctorPaidInPaise: number;
  centreKeepsInPaise: number; costToCentreInPaise: number; costToDoctorInPaise: number;
}
export interface OfferDetail extends OfferRow {
  discountReason: string; whatsappTemplate: string;
  discountGivenInPaise: number;
  referralExamples: {
    centreAbsorbs: ReferralExample; split: ReferralExample;
    doctorShares: ReferralExample; current: ReferralExample;
  };
  stackingRule: string;
}
export const getOffer = (id: string) => apiRequest<OfferDetail>(`${OFF}/${id}`);
export const saveOffer = (id: string, body: Record<string, unknown>) =>
  apiRequest<OfferRow>(`${OFF}/${id}`, { method: 'PUT', body: JSON.stringify(body) });
export const createOffer = (body: Record<string, unknown>) =>
  apiRequest<OfferRow>(OFF, { method: 'POST', body: JSON.stringify(body) });

// ── Shared display helpers ──────────────────────────────────────────────────

/**
 * Reason codes, in the words an operator would use. Three vocabularies are kept
 * visually distinct on purpose — an automation is Active/Paused/Draft, a run is
 * Waiting/Sent/Read/Failed, an outcome is Came in/Control group/Opted out — because
 * collapsing them is how someone concludes a paused automation and a skipped patient
 * are the same kind of fact.
 */



export const rupees = (paise: number | null | undefined) =>
  paise == null ? '—' : `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

// ── Condition vocabulary ────────────────────────────────────────────────────

export interface PredicateMeta {
  fn: string;
  label: string;
  group: 'Diagnostics' | 'Visit' | 'Patient' | 'Money';
  returns: 'BOOLEAN' | 'NUMBER' | 'TEXT';
  scope?: string;
  unit?: 'RUPEES' | 'DAYS' | 'YEARS';
  help?: string;
}
/** Served by the backend so a predicate that does not exist can never be offered. */
export const listPredicates = () =>
  apiRequest<{ predicates: PredicateMeta[] }>(`${AUT}/predicates`);


export interface Recipient {
  id: string; name: string; role: string;
  /** Masked — this list is for choosing from, not for publishing staff numbers. */
  phone: string | null;
}
export const listRecipients = () =>
  apiRequest<{ recipients: Recipient[] }>(`${AUT}/recipients`);

// ── Blueprints: what an automation can BE ───────────────────────────────────

/** MIRRORS blueprints.ts. 'OFFER' was missing here too, which is why the field that
 *  picks a discount campaign fell through to a bare text box. */
export type FieldType = 'TEXT' | 'TIME' | 'NUMBER' | 'BRANCHES' | 'TEMPLATE' | 'CHOICE' | 'OFFER';

export interface BlueprintField {
  key: string; label: string; type: FieldType;
  required?: boolean; default?: string | number; help?: string;
  options?: { value: string; label: string }[];
  approvedOnly?: boolean;
}

export interface Blueprint {
  id: string; title: string; sub: string; group: string;
  scheduled: boolean; holdoutPct: number;
  fields: BlueprintField[];
}

/** Served, so a new kind of automation is a backend entry rather than a React edit. */
export const listBlueprints = () =>
  apiRequest<{ blueprints: Blueprint[] }>(`${AUT}/blueprints`);

/** The browser sends ANSWERS; the definition is assembled on the server. */
export const createFromBlueprint = (body: {
  blueprintId: string; name?: string; values: Record<string, unknown>;
}) => apiRequest<Automation>(`${AUT}/from-blueprint`, {
  method: 'POST', body: JSON.stringify(body),
});

// ── The engine's grammar ────────────────────────────────────────────────────

export interface StepMeta {
  kind: string; label: string; summary: string;
  sends: boolean; branches: boolean; terminal: boolean;
}
/** Served so the builder can tell when it has fallen behind the engine. */
export const listStepKinds = () => apiRequest<{ steps: StepMeta[] }>(`${AUT}/steps`);

export interface DefinitionProblem { where: string; problem: string; blocking: boolean }
export const validateDefinition = (definition: AutomationDefinition) =>
  apiRequest<{ problems: DefinitionProblem[] }>(`${AUT}/validate`, {
    method: 'POST', body: JSON.stringify({ definition }),
  });

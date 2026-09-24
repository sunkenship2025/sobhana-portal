/**
 * Prescription lifecycle — the state machine, enforced here rather than in the UI.
 *
 * DRAFT --sign--> SIGNED --amend--> new DRAFT (old stays SIGNED) --sign--> old SUPERSEDED
 *
 * A correction does not retire the old version when it is STARTED, only when the
 * new one is signed. Until then the patient's link, the staff print and the
 * doctor's history all keep showing what was actually signed — a half-written
 * correction is not a prescription. There is at most one SIGNED row per root.
 *
 * The safety rule from PART 29 of the brief is a SERVER rule: an AI draft can
 * never reach a patient. `sign()` is the only path to SIGNED, it refuses while the
 * validator reports anything BLOCK or ASK, and sending is a separate call that
 * refuses anything not SIGNED. A frontend that forgot every guard could still not
 * transmit a draft.
 *
 * IMMUTABILITY IS A FROZEN PAYLOAD, NOT A STATUS COLUMN
 * Signing snapshots the doctor block, registration number, signature image,
 * branch letterhead and patient identity. A signed prescription renders from that
 * snapshot forever. Otherwise a doctor correcting their own qualification next
 * month silently rewrites a document they signed in September — which is exactly
 * the bug the report footer already had before it was frozen into a snapshot.
 */
import { Prisma } from '@prisma/client';
import type { PrescriptionStatus } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { logAction } from '../auditService';
import { resolveMedication } from './resolver';
import { validatePrescription, type ValidatableItem, type ValidationResult } from './validator';
import { FREQUENCY_TEXT, type FrequencyCode } from './normalize';
import type { ExtractedItem } from './extract';
import { learnFromSignedPrescription } from './learning';

export class PrescriptionStateError extends Error {}
/** The signer is not the prescribing doctor. Distinct from a state error so the
 *  route can answer 403 — this is "you may not", not "this cannot happen yet". */
export class PrescriptionSignerError extends Error {}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface PrescriptionSnapshot {
  doctor: {
    name: string;
    qualification: string;
    specialty: string;
    /**
     * MANDATORY on the sheet AND on any electronic message carrying it —
     * Telemedicine Practice Guidelines §3.2.5 lists "prescriptions, website,
     * electronic communication (WhatsApp/email etc.) and receipts".
     */
    registrationNumber: string;
    letterheadNote: string | null;
    signatureImageBase64: string | null;
  };
  branch: { id: string; name: string; address: string | null; phone: string | null };
  patient: {
    id: string; patientNumber: string; name: string; title: string | null;
    ageLabel: string; gender: string; phone: string | null;
  };
  visit: { id: string; visitType: string | null; tokenNumber: number | null; date: string };
  signedAt: string;
  signedByUserId: string | null;
  /** Set on a correction: the version it replaces, printed as "Revised · replaces…". */
  revises?: { version: number; signedAt: string } | null;
}

/** Age the way a clinician reads it — days for a newborn, months for an infant. */
function ageLabel(p: { yearOfBirth: number; dateOfBirth: Date | null; ageUnit: string }): string {
  const now = new Date();
  if (p.dateOfBirth) {
    const days = Math.floor((now.getTime() - p.dateOfBirth.getTime()) / 86_400_000);
    if (days < 60) return `${days} d`;
    const months = Math.floor(days / 30.44);
    if (months < 24) return `${months} m`;
    return `${Math.floor(days / 365.25)} y`;
  }
  const years = now.getFullYear() - p.yearOfBirth;
  if (p.ageUnit === 'DAYS') return `${years} d`;
  if (p.ageUnit === 'MONTHS') return `${years} m`;
  return `${years} y`;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const ITEM_SELECT = {
  id: true, displayOrder: true, spokenText: true, medicationId: true, canonicalName: true,
  genericName: true, brandName: true, strength: true, strengthUnit: true, dosageForm: true,
  doseQty: true, doseUnit: true, frequencyCode: true, frequencyText: true, route: true,
  timing: true, durationValue: true, durationUnit: true, instructions: true,
  resolution: true, candidates: true, fieldStates: true,
  sourceText: true, sourceStart: true, sourceEnd: true,
} satisfies Prisma.PrescriptionItemSelect;

export const PRESCRIPTION_SELECT = {
  id: true, visitId: true, clinicDoctorId: true, branchId: true,
  rootId: true, version: true, isLatest: true, previousVersionId: true, revisionReason: true,
  status: true, diagnosis: true, notes: true, followUpDays: true,
  signedAt: true, signedByUserId: true, snapshot: true,
  transcript: true, transcriptSegments: true, asrProvider: true, asrModel: true,
  asrLanguage: true, extractionModel: true, audioKey: true, audioDurationSec: true,
  audioDeletedAt: true, createdAt: true, updatedAt: true,
  items: { select: ITEM_SELECT, orderBy: { displayOrder: 'asc' as const } },
  clinicDoctor: { select: { id: true, name: true, qualification: true, specialty: true, registrationNumber: true } },
} satisfies Prisma.PrescriptionSelect;

const toValidatable = (items: any[]): ValidatableItem[] =>
  items.map((i) => ({
    id: i.id,
    canonicalName: i.canonicalName,
    // Passed through so the controlled-substance screen can read what the doctor
    // actually SAID, not only what we managed to resolve it to.
    spokenText: i.spokenText,
    genericName: i.genericName,
    brandName: i.brandName,
    medicationId: i.medicationId,
    strength: i.strength,
    strengthUnit: i.strengthUnit,
    dosageForm: i.dosageForm,
    doseQty: i.doseQty,
    doseUnit: i.doseUnit,
    frequencyCode: i.frequencyCode,
    route: i.route,
    timing: i.timing,
    durationValue: i.durationValue,
    durationUnit: i.durationUnit,
    instructions: i.instructions,
    resolution: i.resolution,
    // An unpicked alternative is stored as resolution AMBIGUOUS with candidates;
    // the flag itself rides on fieldStates so no column is needed for it.
    isAlternative: !!(i.fieldStates as any)?.isAlternative,
  }));

export async function validateById(prescriptionId: string, isTelemedicine = false): Promise<ValidationResult> {
  const rx = await prisma.prescription.findFirst({
    where: { id: prescriptionId, deletedAt: null },
    select: { items: { select: ITEM_SELECT }, diagnosis: true, followUpDays: true, transcript: true },
  });
  if (!rx) throw new PrescriptionStateError('Prescription not found');
  return validatePrescription({
    items: toValidatable(rx.items),
    diagnosis: rx.diagnosis,
    followUpDays: rx.followUpDays,
    transcript: rx.transcript,
    isTelemedicine,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  visitId: string;
  clinicDoctorId: string;
  branchId: string;
  userId: string;
  /** Voice provenance — all null for a typed prescription. */
  transcript?: string | null;
  transcriptSegments?: unknown;
  asrProvider?: string | null;
  asrModel?: string | null;
  asrLanguage?: string | null;
  extractionModel?: string | null;
  audioKey?: string | null;
  audioDurationSec?: number | null;
  diagnosis?: string | null;
  notes?: string | null;
  followUpDays?: number | null;
  items?: ExtractedItem[];
}

/**
 * Match a dictated line against the catalogue. A name the extractor REPAIRED
 * from a mishearing ("Set Scene 10" -> Cetzine) is never matched silently, even
 * when the repair names a real medicine exactly: it comes back as a question
 * with the repair offered first, so the doctor confirms it with one tap. Same
 * rule as the resolver's own approximate tiers — a guess never decides a drug.
 *
 * Unless the repair changed nothing: when what was HEARD resolves, on its own,
 * to the same medicine ("Pan 40" -> Pantoprazole 40, the clinic's shorthand),
 * there was no guess to confirm.
 */
async function resolveLine(
  spoken: string,
  it: { strength?: string | null; dosageForm?: string | null; fieldStates?: unknown; spokenText?: string | null },
) {
  const opts = { strength: it.strength ?? null, dosageForm: it.dosageForm ?? null };
  const r = await resolveMedication({ spoken, ...opts });
  const repaired = (it.fieldStates as Record<string, unknown> | null | undefined)?.name === 'NORMALIZED';
  if (repaired && r.resolution === 'RESOLVED' && r.match) {
    const heard = (it.spokenText ?? '').trim();
    if (heard && heard !== spoken) {
      const asHeard = await resolveMedication({ spoken: heard, ...opts });
      if (asHeard.resolution === 'RESOLVED' && asHeard.match?.medicationId === r.match.medicationId) return r;
    }
    const first = r.match;
    return {
      ...r,
      resolution: 'UNRESOLVED' as const,
      match: null,
      candidates: [first, ...r.candidates.filter((c) => c.medicationId !== first.medicationId)],
      askReason: 'NO_MATCH' as const,
    };
  }
  return r;
}

/**
 * Resolve an extracted item against the catalog and shape it for storage.
 * The LLM's name goes to the resolver; the resolver's answer goes to the sheet.
 */
async function buildItem(it: ExtractedItem, order: number): Promise<Prisma.PrescriptionItemCreateWithoutPrescriptionInput> {
  const r = await resolveLine(it.name || it.spokenText, it);

  const matched = r.match;
  const freq = (it.frequencyCode ?? null) as FrequencyCode | null;

  return {
    displayOrder: order,
    spokenText: it.spokenText || null,
    // Relation form, not the scalar: a nested create needs `connect`.
    medication: matched ? { connect: { id: matched.medicationId } } : undefined,
    // Unresolved keeps what the doctor SAID as the printed name. They are the
    // authority; our catalog being incomplete is our problem, not theirs.
    canonicalName: matched?.canonicalName ?? (it.name || it.spokenText),
    genericName: matched?.genericName ?? null,
    brandName: matched?.brandName ?? null,
    strength: it.strength ?? matched?.strength ?? null,
    strengthUnit: it.strengthUnit ?? matched?.strengthUnit ?? null,
    dosageForm: it.dosageForm ?? matched?.dosageForm ?? null,
    doseQty: it.doseQty,
    doseUnit: it.doseUnit,
    frequencyCode: freq,
    frequencyText: freq ? FREQUENCY_TEXT[freq] : null,
    route: it.route ?? matched?.route ?? null,
    timing: it.timing,
    durationValue: it.durationValue,
    durationUnit: it.durationUnit,
    instructions: it.instructions,
    resolution: r.resolution,
    candidates: r.candidates.length ? (r.candidates as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    // askReason rides on fieldStates so the question survives a reload without a
    // column of its own — the queue must be able to rebuild itself from the draft.
    fieldStates: {
      ...it.fieldStates,
      isAlternative: it.isAlternative,
      askReason: r.askReason ?? null,
      spokenStrength: r.spokenStrength ?? null,
    } as unknown as Prisma.InputJsonValue,
    sourceText: it.sourceText,
    sourceStart: it.sourceStart,
    sourceEnd: it.sourceEnd,
  };
}

export async function createDraft(input: CreateDraftInput) {
  const items = await Promise.all((input.items ?? []).map((it, i) => buildItem(it, i)));

  const created = await prisma.prescription.create({
    data: {
      visitId: input.visitId,
      clinicDoctorId: input.clinicDoctorId,
      branchId: input.branchId,
      // rootId is patched to self immediately below — a prescription is its own root.
      rootId: 'pending',
      version: 1,
      isLatest: true,
      status: 'DRAFT',
      diagnosis: input.diagnosis ?? null,
      notes: input.notes ?? null,
      followUpDays: input.followUpDays ?? null,
      transcript: input.transcript ?? null,
      transcriptSegments: (input.transcriptSegments as Prisma.InputJsonValue) ?? Prisma.DbNull,
      asrProvider: input.asrProvider ?? null,
      asrModel: input.asrModel ?? null,
      asrLanguage: input.asrLanguage ?? null,
      extractionModel: input.extractionModel ?? null,
      audioKey: input.audioKey ?? null,
      audioDurationSec: input.audioDurationSec ?? null,
      items: { create: items },
    },
    select: { id: true, branchId: true },
  });

  await prisma.prescription.update({ where: { id: created.id }, data: { rootId: created.id } });

  await logAction({
    branchId: created.branchId,
    actionType: 'CREATE',
    entityType: 'Prescription',
    entityId: created.id,
    userId: input.userId,
    newValues: {
      visitId: input.visitId,
      itemCount: items.length,
      source: input.transcript ? 'VOICE' : 'TYPED',
      asrProvider: input.asrProvider ?? null,
      extractionModel: input.extractionModel ?? null,
    },
  });

  return getById(created.id);
}

export async function getById(id: string) {
  return prisma.prescription.findFirst({ where: { id, deletedAt: null }, select: PRESCRIPTION_SELECT });
}

// ---------------------------------------------------------------------------
// Update — DRAFT only
// ---------------------------------------------------------------------------

export interface UpdateItemInput {
  id?: string;
  medicationId?: string | null;
  canonicalName: string;
  genericName?: string | null;
  brandName?: string | null;
  strength?: string | null;
  strengthUnit?: string | null;
  dosageForm?: string | null;
  doseQty?: string | null;
  doseUnit?: string | null;
  frequencyCode?: string | null;
  route?: string | null;
  timing?: string | null;
  durationValue?: number | null;
  durationUnit?: string | null;
  instructions?: string | null;
  /** Set MANUAL whenever the doctor touched it — we never re-resolve their choice. */
  resolution?: string;
  spokenText?: string | null;
  sourceText?: string | null;
  sourceStart?: number | null;
  sourceEnd?: number | null;
  /** From extraction, on a NEW dictated item only — e.g. isAlternative ("either
   *  X or Y"). askReason is never taken from here; the server computes it. */
  fieldStates?: Record<string, unknown> | null;
}

export async function updateDraft(
  id: string,
  userId: string,
  patch: {
    diagnosis?: string | null;
    notes?: string | null;
    followUpDays?: number | null;
    items?: UpdateItemInput[];
  },
) {
  const current = await prisma.prescription.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, status: true, branchId: true, items: { select: ITEM_SELECT } },
  });
  if (!current) throw new PrescriptionStateError('Prescription not found');
  if (current.status !== 'DRAFT') {
    throw new PrescriptionStateError('A signed prescription cannot be edited. Create a revision instead.');
  }

  // A NEW item arriving with no resolution is dictation that has not been
  // checked against the catalogue yet. Resolve it HERE, on the server.
  //
  // This is the path the real screen takes, and until now it resolved nothing:
  // extraction does not resolve, the page stamped every dictated medicine MANUAL
  // ("Your choice"), and this function stored whatever it was handed. So in the
  // live UI no dictated drug was ever matched, no "which one?" was ever asked, and
  // a mishearing like "Aumintin 625" went straight onto the sheet as the doctor's
  // own choice. Only createDraft resolved — the path the checks seed through —
  // which is why every check passed while the screen did something else.
  //
  // Server-side, not trusted from the request, for the same reason candidates are
  // carried from the stored row below: the client must not be able to invent the
  // options a question offers. A human decision (MANUAL from a pick, UNRESOLVED
  // from "write as typed") always arrives with a resolution and is left alone.
  const fresh = new Map<number, Awaited<ReturnType<typeof resolveMedication>>>();
  if (patch.items) {
    await Promise.all(patch.items.map(async (it, i) => {
      if (it.id || it.resolution != null) return;
      const spoken = (it.canonicalName || it.spokenText || '').trim();
      if (!spoken) return;
      fresh.set(i, await resolveLine(spoken, it));
    }));
  }

  await prisma.$transaction(async (tx) => {
    await tx.prescription.update({
      where: { id },
      data: {
        diagnosis: patch.diagnosis ?? undefined,
        notes: patch.notes ?? undefined,
        followUpDays: patch.followUpDays ?? undefined,
      },
    });

    if (patch.items) {
      // Replace wholesale: the editor owns the list, and a diff here would be
      // more code than it saves. Items are cheap and the set is tiny.
      await tx.prescriptionItem.deleteMany({ where: { prescriptionId: id } });
      const prior = new Map(current.items.map((i) => [i.id, i]));
      await tx.prescriptionItem.createMany({
        data: patch.items.map((it, i) => {
          const was = it.id ? prior.get(it.id) : undefined;
          const freq = (it.frequencyCode ?? null) as FrequencyCode | null;
          const r = fresh.get(i);
          if (r) {
            const m = r.match;
            return {
              prescriptionId: id,
              displayOrder: i,
              spokenText: it.spokenText ?? null,
              medicationId: m?.medicationId ?? null,
              // Unmatched keeps what the doctor SAID as the printed name.
              canonicalName: m?.canonicalName ?? it.canonicalName,
              genericName: m?.genericName ?? null,
              brandName: m?.brandName ?? null,
              strength: it.strength ?? m?.strength ?? null,
              strengthUnit: it.strengthUnit ?? m?.strengthUnit ?? null,
              dosageForm: it.dosageForm ?? m?.dosageForm ?? null,
              doseQty: it.doseQty ?? null,
              doseUnit: it.doseUnit ?? null,
              frequencyCode: freq,
              frequencyText: freq ? FREQUENCY_TEXT[freq] : null,
              route: it.route ?? m?.route ?? null,
              timing: it.timing ?? null,
              durationValue: it.durationValue ?? null,
              durationUnit: it.durationUnit ?? null,
              instructions: it.instructions ?? null,
              resolution: r.resolution as any,
              // The server's own options — the question comes back with answers.
              candidates: r.resolution !== 'RESOLVED' && r.candidates.length
                ? (r.candidates as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
              sourceText: it.sourceText ?? null,
              sourceStart: it.sourceStart ?? null,
              sourceEnd: it.sourceEnd ?? null,
              // Extraction's flags (isAlternative — "either X or Y") survive the
              // save; askReason is the server's, never the request's.
              fieldStates: {
                ...(it.fieldStates ?? {}),
                askReason: r.askReason ?? null,
                spokenStrength: r.spokenStrength ?? null,
              } as unknown as Prisma.InputJsonValue,
            };
          }
          const res = (it.resolution as string) ?? 'MANUAL';
          const resolved = res === 'MANUAL' || res === 'RESOLVED';
          return {
            prescriptionId: id,
            displayOrder: i,
            spokenText: it.spokenText ?? was?.spokenText ?? null,
            medicationId: it.medicationId ?? null,
            canonicalName: it.canonicalName,
            genericName: it.genericName ?? null,
            brandName: it.brandName ?? null,
            strength: it.strength ?? null,
            strengthUnit: it.strengthUnit ?? null,
            dosageForm: it.dosageForm ?? null,
            doseQty: it.doseQty ?? null,
            doseUnit: it.doseUnit ?? null,
            frequencyCode: freq,
            frequencyText: freq ? FREQUENCY_TEXT[freq] : null,
            route: it.route ?? null,
            timing: it.timing ?? null,
            durationValue: it.durationValue ?? null,
            durationUnit: it.durationUnit ?? null,
            instructions: it.instructions ?? null,
            resolution: (it.resolution as any) ?? 'MANUAL',
            // An UNANSWERED question must survive a draft save WITH ITS OPTIONS.
            // Saving used to drop them, so the queue came back asking something it
            // could no longer offer an answer to. Carried from the prior row rather
            // than from the request: the client must not be able to invent options.
            candidates: resolved
              ? Prisma.DbNull
              : ((was?.candidates as Prisma.InputJsonValue) ?? Prisma.DbNull),
            // Source spans survive an edit: provenance belongs to what was SAID,
            // not to whether the doctor later adjusted the value.
            sourceText: it.sourceText ?? was?.sourceText ?? null,
            sourceStart: it.sourceStart ?? was?.sourceStart ?? null,
            sourceEnd: it.sourceEnd ?? was?.sourceEnd ?? null,
            // The server's flags (askReason, spokenStrength) are carried from the
            // prior row. The one the doctor may change is settling an either/or:
            // picking one option clears its isAlternative — without this the pick
            // was dropped on save and the choice blocked signing forever.
            fieldStates: was?.fieldStates
              ? ({
                  ...(was.fieldStates as Record<string, unknown>),
                  ...(it.fieldStates?.isAlternative === false ? { isAlternative: false } : {}),
                } as Prisma.InputJsonValue)
              : Prisma.DbNull,
          };
        }),
      });
    }
  });

  await logAction({
    branchId: current.branchId,
    actionType: 'UPDATE',
    entityType: 'Prescription',
    entityId: id,
    userId,
    oldValues: { items: current.items.map((i) => ({ name: i.canonicalName, strength: i.strength, freq: i.frequencyCode })) },
    newValues: { items: (patch.items ?? []).map((i) => ({ name: i.canonicalName, strength: i.strength, freq: i.frequencyCode })) },
  });

  return getById(id);
}

// ---------------------------------------------------------------------------
// Sign — the irreversible transition
// ---------------------------------------------------------------------------

/**
 * May this user sign a prescription for this consulting doctor — and if not, why.
 *
 * ONE definition, used by sign() to refuse and by the consultation screen to
 * disable its Sign button with the same words. Two copies of this rule would
 * eventually disagree, and the screen would offer a button the server refuses.
 *
 *   NOT_THE_PRESCRIBER  the signed-in user is not this doctor's own login
 *                       (an owner included — see sign() for why)
 *   NO_SIGNATURE        the doctor has no signature on file; radiology already
 *                       refuses to finalize without a signer, same rule
 */
export async function signerCheck(
  clinicDoctorId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; code: 'NOT_THE_PRESCRIBER' | 'NO_SIGNATURE' | 'NO_DOCTOR'; reason: string }> {
  const d = await prisma.clinicDoctor.findUnique({
    where: { id: clinicDoctorId },
    select: { name: true, userId: true, isActive: true, signatureImageBase64: true },
  });
  if (!d) return { ok: false, code: 'NO_DOCTOR', reason: 'Consulting doctor not found' };
  // Names carry stray whitespace in prod ("Dr. SURENDER SINGH "); trim for the message.
  const name = d.name.trim();
  if (!d.isActive || !d.userId || d.userId !== userId) {
    return {
      ok: false,
      code: 'NOT_THE_PRESCRIBER',
      reason: `Only ${name} can sign this prescription — it goes out under their registration number and signature.`,
    };
  }
  if (!d.signatureImageBase64) {
    return {
      ok: false,
      code: 'NO_SIGNATURE',
      reason: `${name} has no signature on file. Add one under Consulting doctor logins, then sign.`,
    };
  }
  return { ok: true };
}

export async function sign(
  id: string,
  userId: string,
  opts: { isTelemedicine?: boolean; ip?: string; userAgent?: string } = {},
) {
  const rx = await prisma.prescription.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, status: true, branchId: true, visitId: true, clinicDoctorId: true,
      rootId: true, previousVersionId: true,
      transcript: true,
      items: { select: ITEM_SELECT },
    },
  });
  if (!rx) throw new PrescriptionStateError('Prescription not found');
  if (rx.status === 'SIGNED') throw new PrescriptionStateError('Already signed');
  if (rx.status === 'SUPERSEDED') throw new PrescriptionStateError('This revision has been superseded');

  // WHO may sign: the visit's own doctor, through their own login, and nobody
  // else — whatever their role. The sheet carries this doctor's name,
  // registration number and signature image, so pressing Sign is the doctor
  // attesting to the order. Reports work differently on purpose: there staff
  // finalize and the pathologist's signature prints, because a report is the
  // doctor's review of lab output. A prescription is the doctor's own order, and
  // letting an owner apply that signature would put a registration number on a
  // document its holder never saw.
  //
  // Checked HERE, in the one function every signature goes through, not in the
  // route — so no future caller can sign without it. Before the validator,
  // because "you may not" should not wait on "is it complete".
  const may = await signerCheck(rx.clinicDoctorId, userId);
  if (!may.ok) {
    if (may.code === 'NOT_THE_PRESCRIBER') throw new PrescriptionSignerError(may.reason);
    throw new PrescriptionStateError(may.reason);
  }

  // The gate. Refusing here, not in the UI, is what makes PART 29 real.
  const validation = await validatePrescription({
    items: toValidatable(rx.items),
    transcript: rx.transcript,
    isTelemedicine: !!opts.isTelemedicine,
  });
  if (!validation.canSign) {
    const blocking = validation.findings.filter((f) => f.severity !== 'NOTE');
    throw new PrescriptionStateError(
      `Cannot sign — ${blocking.length} item(s) need attention: ${blocking.map((f) => f.message).join(' | ')}`,
    );
  }

  const [doctor, visit, previous] = await Promise.all([
    prisma.clinicDoctor.findUnique({
      where: { id: rx.clinicDoctorId },
      select: {
        name: true, qualification: true, specialty: true, registrationNumber: true,
        letterheadNote: true, signatureImageBase64: true,
      },
    }),
    prisma.visit.findUnique({
      where: { id: rx.visitId },
      select: {
        id: true, createdAt: true,
        branch: { select: { id: true, name: true, address: true, phone: true } },
        patient: {
          select: {
            id: true, patientNumber: true, name: true, title: true, gender: true,
            yearOfBirth: true, dateOfBirth: true, ageUnit: true,
            identifiers: { where: { type: 'PHONE' }, select: { value: true }, take: 1 },
          },
        },
        clinicVisit: { select: { visitType: true, tokenNumber: true } },
      },
    }),
    rx.previousVersionId
      ? prisma.prescription.findUnique({ where: { id: rx.previousVersionId }, select: { version: true, signedAt: true } })
      : null,
  ]);

  if (!doctor) throw new PrescriptionStateError('Consulting doctor not found');
  if (!visit) throw new PrescriptionStateError('Visit not found');
  if (!doctor.registrationNumber) {
    // Not a nicety: §3.2.5 requires the registration number on every prescription.
    throw new PrescriptionStateError('This doctor has no registration number on file — required on every prescription.');
  }

  const signedAt = new Date();
  const snapshot: PrescriptionSnapshot = {
    doctor: {
      name: doctor.name,
      qualification: doctor.qualification,
      specialty: doctor.specialty,
      registrationNumber: doctor.registrationNumber,
      letterheadNote: doctor.letterheadNote,
      signatureImageBase64: doctor.signatureImageBase64,
    },
    branch: visit.branch,
    patient: {
      id: visit.patient.id,
      patientNumber: visit.patient.patientNumber,
      name: visit.patient.name,
      title: visit.patient.title,
      ageLabel: ageLabel(visit.patient),
      gender: visit.patient.gender,
      phone: visit.patient.identifiers[0]?.value ?? null,
    },
    visit: {
      id: visit.id,
      visitType: visit.clinicVisit?.visitType ?? null,
      tokenNumber: visit.clinicVisit?.tokenNumber ?? null,
      date: (visit.createdAt ?? signedAt).toISOString(),
    },
    signedAt: signedAt.toISOString(),
    signedByUserId: userId,
    revises: previous?.signedAt ? { version: previous.version, signedAt: previous.signedAt.toISOString() } : null,
  };

  await prisma.$transaction([
    prisma.prescription.update({
      where: { id },
      data: {
        status: 'SIGNED',
        signedAt,
        signedByUserId: userId,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    }),
    // A signed correction is the moment the old version stops being the
    // prescription — not when the correction was opened. See the header.
    prisma.prescription.updateMany({
      where: { rootId: rx.rootId, status: 'SIGNED', id: { not: id } },
      data: { status: 'SUPERSEDED', isLatest: false },
    }),
  ]);

  await logAction({
    branchId: rx.branchId,
    actionType: 'SIGN',
    entityType: 'Prescription',
    entityId: id,
    userId,
    ipAddress: opts.ip,
    userAgent: opts.userAgent,
    newValues: {
      signedAt: signedAt.toISOString(),
      doctor: doctor.name,
      registrationNumber: doctor.registrationNumber,
      items: rx.items.map((i) => ({
        name: i.canonicalName, strength: i.strength, frequency: i.frequencyCode,
        duration: i.durationValue, spokenAs: i.spokenText,
      })),
    },
  });

  // The catalogue learns from what was actually prescribed: free text becomes a
  // findable row, a correction becomes an alias, and usage ranks the clinic's own
  // vocabulary above the long tail. Deliberately AFTER the record is written and
  // deliberately not awaited into the response — a catalogue improvement must
  // never be able to fail a signature.
  learnFromSignedPrescription(
    rx.items.map((i) => ({
      canonicalName: i.canonicalName,
      spokenText: i.spokenText,
      medicationId: i.medicationId,
      genericName: i.genericName,
      brandName: i.brandName,
      strength: i.strength,
      strengthUnit: i.strengthUnit,
      dosageForm: i.dosageForm,
      route: i.route,
      resolution: i.resolution,
    })),
    userId,
  ).catch((err) => logger.error({ err, prescriptionId: id }, 'voiceRx: learning failed'));

  return getById(id);
}

// ---------------------------------------------------------------------------
// Amend — a signed prescription is corrected by REVISION, never by edit
// ---------------------------------------------------------------------------

export async function amend(id: string, userId: string, reason: string) {
  if (!reason || reason.trim().length < 3) {
    throw new PrescriptionStateError('A reason is required to revise a signed prescription');
  }

  const old = await prisma.prescription.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, rootId: true, version: true, status: true, visitId: true, branchId: true,
      clinicDoctorId: true, diagnosis: true, notes: true, followUpDays: true,
      transcript: true, transcriptSegments: true, asrProvider: true, asrModel: true,
      asrLanguage: true, extractionModel: true, audioKey: true, audioDurationSec: true,
      items: { select: ITEM_SELECT, orderBy: { displayOrder: 'asc' } },
    },
  });
  if (!old) throw new PrescriptionStateError('Prescription not found');
  if (old.status !== 'SIGNED') throw new PrescriptionStateError('Only a signed prescription is revised; edit the draft instead');
  const open = await prisma.prescription.findFirst({
    where: { rootId: old.rootId, status: 'DRAFT', deletedAt: null }, select: { id: true },
  });
  if (open) throw new PrescriptionStateError('A correction is already open for this prescription');

  const next = await prisma.$transaction(async (tx) => {
    // The old version stays SIGNED — it is still the prescription until the
    // correction is signed. It only stops being the latest row of its root.
    await tx.prescription.update({ where: { id: old.id }, data: { isLatest: false } });

    return tx.prescription.create({
      data: {
        visitId: old.visitId,
        clinicDoctorId: old.clinicDoctorId,
        branchId: old.branchId,
        rootId: old.rootId,
        version: old.version + 1,
        isLatest: true,
        previousVersionId: old.id,
        revisionReason: reason.trim(),
        status: 'DRAFT',
        diagnosis: old.diagnosis,
        notes: old.notes,
        followUpDays: old.followUpDays,
        transcript: old.transcript,
        transcriptSegments: (old.transcriptSegments as Prisma.InputJsonValue) ?? Prisma.DbNull,
        asrProvider: old.asrProvider,
        asrModel: old.asrModel,
        asrLanguage: old.asrLanguage,
        extractionModel: old.extractionModel,
        audioKey: old.audioKey,
        audioDurationSec: old.audioDurationSec,
        items: {
          create: old.items.map((i, idx) => ({
            displayOrder: idx,
            spokenText: i.spokenText,
            medicationId: i.medicationId,
            canonicalName: i.canonicalName,
            genericName: i.genericName,
            brandName: i.brandName,
            strength: i.strength,
            strengthUnit: i.strengthUnit,
            dosageForm: i.dosageForm,
            doseQty: i.doseQty,
            doseUnit: i.doseUnit,
            frequencyCode: i.frequencyCode,
            frequencyText: i.frequencyText,
            route: i.route,
            timing: i.timing,
            durationValue: i.durationValue,
            durationUnit: i.durationUnit,
            instructions: i.instructions,
            resolution: i.resolution,
            candidates: (i.candidates as Prisma.InputJsonValue) ?? Prisma.DbNull,
            fieldStates: (i.fieldStates as Prisma.InputJsonValue) ?? Prisma.DbNull,
            sourceText: i.sourceText,
            sourceStart: i.sourceStart,
            sourceEnd: i.sourceEnd,
          })),
        },
      },
      select: { id: true },
    });
  });

  await logAction({
    branchId: old.branchId,
    actionType: 'AMEND',
    entityType: 'Prescription',
    entityId: next.id,
    userId,
    oldValues: { supersededId: old.id, version: old.version },
    newValues: { version: old.version + 1, reason: reason.trim() },
  });

  return getById(next.id);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Throw away an unsigned draft (soft). A signed prescription is never deleted —
 * it is superseded. Discarding a CORRECTION hands "latest" back to the signed
 * version it was correcting, which never stopped being the prescription.
 *
 * The recording goes too, unless another row still points at it: a correction
 * is opened with its original's audio key, and that one is signed and kept.
 */
export async function discardDraft(id: string, userId: string | null, why: 'discarded' | 'abandoned' = 'discarded') {
  const rx = await prisma.prescription.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, status: true, branchId: true, audioKey: true, previousVersionId: true },
  });
  if (!rx) throw new PrescriptionStateError('Prescription not found');
  if (rx.status !== 'DRAFT') throw new PrescriptionStateError('A signed prescription cannot be deleted');

  await prisma.$transaction([
    prisma.prescription.update({ where: { id }, data: { deletedAt: new Date(), isLatest: false } }),
    ...(rx.previousVersionId
      ? [prisma.prescription.updateMany({ where: { id: rx.previousVersionId, status: 'SIGNED' }, data: { isLatest: true } })]
      : []),
  ]);

  if (rx.audioKey) {
    const shared = await prisma.prescription.count({ where: { audioKey: rx.audioKey, deletedAt: null } });
    if (shared === 0) {
      const { deleteObject } = await import('../r2StorageService');
      deleteObject(rx.audioKey).catch((err) => logger.error({ err }, 'prescriptions: audio delete failed'));
    }
  }

  await logAction({
    branchId: rx.branchId,
    actionType: 'DELETE',
    entityType: 'Prescription',
    entityId: id,
    userId: userId ?? undefined,
    oldValues: { status: rx.status },
    newValues: { why },
  });
}

/** A draft nobody has touched for a week, on a visit that is already over. */
const ABANDONED_AFTER_MS = 7 * 86_400_000;

/**
 * Clear abandoned drafts. Run when a doctor opens their queue rather than on a
 * timer: a 5-minute sweep is what kept Neon awake, and nobody sees the drafts
 * list except through this screen. Only CLOSED visits — a patient still with the
 * doctor never loses their draft, however long it has sat.
 */
async function clearAbandonedDrafts() {
  const stale = await prisma.prescription.findMany({
    where: {
      status: 'DRAFT', deletedAt: null,
      updatedAt: { lt: new Date(Date.now() - ABANDONED_AFTER_MS) },
      OR: [
        { visit: { status: 'CANCELLED' } },
        { visit: { clinicVisit: { status: 'COMPLETED' } } },
      ],
    },
    select: { id: true },
    take: 50,
  });
  for (const d of stale) await discardDraft(d.id, null, 'abandoned').catch(() => {});
}

/** Unsigned drafts for a doctor — the amber strip on the queue. */
export async function listDrafts(clinicDoctorId: string, branchId: string) {
  await clearAbandonedDrafts().catch((err) => logger.error({ err }, 'prescriptions: abandoned-draft sweep failed'));
  return prisma.prescription.findMany({
    where: { clinicDoctorId, branchId, status: 'DRAFT', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, createdAt: true, visitId: true,
      items: { select: { canonicalName: true, resolution: true } },
      visit: {
        select: {
          id: true,
          patient: { select: { name: true, patientNumber: true, gender: true, yearOfBirth: true, dateOfBirth: true, ageUnit: true } },
        },
      },
    },
  });
}

/** Every prescription on a visit — latest revision of each root, newest first. */
export async function listForVisit(visitId: string) {
  return prisma.prescription.findMany({
    where: { visitId, isLatest: true, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    select: PRESCRIPTION_SELECT,
  });
}

/** Signed prescription history for a patient — the doctor's clinical context. */
export async function listForPatient(patientId: string, limit = 20) {
  return prisma.prescription.findMany({
    where: { visit: { patientId }, status: 'SIGNED', deletedAt: null },
    orderBy: { signedAt: 'desc' },
    take: limit,
    select: {
      id: true, signedAt: true, visitId: true, diagnosis: true, followUpDays: true,
      items: {
        select: {
          canonicalName: true, strength: true, strengthUnit: true, doseQty: true, doseUnit: true,
          frequencyCode: true, frequencyText: true, timing: true, durationValue: true, durationUnit: true,
        },
        orderBy: { displayOrder: 'asc' },
      },
      clinicDoctor: { select: { name: true } },
    },
  });
}

/**
 * "Currently on N medicines" — signed items whose duration has not elapsed.
 *
 * The most useful single number a prescriber can be handed, and nothing in this
 * portal can show it today. An item with NO duration counts as ongoing, which is
 * the clinically correct reading of a long-term antihypertensive.
 */
export async function currentMedications(patientId: string) {
  const rows = await listForPatient(patientId, 40);
  const now = Date.now();
  const active = new Map<string, { name: string; since: Date }>();

  for (const rx of [...rows].reverse()) {
    if (!rx.signedAt) continue;
    for (const it of rx.items) {
      const days = it.durationValue == null
        ? null
        : it.durationUnit === 'weeks' ? it.durationValue * 7
        : it.durationUnit === 'months' ? it.durationValue * 30
        : it.durationValue;
      const ongoing = days == null || rx.signedAt.getTime() + days * 86_400_000 > now;
      const key = it.canonicalName.toLowerCase();
      if (ongoing) active.set(key, { name: it.canonicalName, since: rx.signedAt });
      else active.delete(key);
    }
  }
  return [...active.values()];
}

export const TERMINAL_STATUSES: PrescriptionStatus[] = ['SIGNED', 'SUPERSEDED'];

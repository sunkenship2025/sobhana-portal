/**
 * Prescription lifecycle — the state machine, enforced here rather than in the UI.
 *
 * DRAFT --sign--> SIGNED --amend--> (old: SUPERSEDED, new: DRAFT --sign--> SIGNED)
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
import { logAction } from '../auditService';
import { resolveMedication } from './resolver';
import { validatePrescription, type ValidatableItem, type ValidationResult } from './validator';
import { FREQUENCY_TEXT, type FrequencyCode } from './normalize';
import type { ExtractedItem } from './extract';

export class PrescriptionStateError extends Error {}

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
    select: { items: { select: ITEM_SELECT }, diagnosis: true, followUpDays: true },
  });
  if (!rx) throw new PrescriptionStateError('Prescription not found');
  return validatePrescription({
    items: toValidatable(rx.items),
    diagnosis: rx.diagnosis,
    followUpDays: rx.followUpDays,
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
 * Resolve an extracted item against the catalog and shape it for storage.
 * The LLM's name goes to the resolver; the resolver's answer goes to the sheet.
 */
async function buildItem(it: ExtractedItem, order: number): Promise<Prisma.PrescriptionItemCreateWithoutPrescriptionInput> {
  const r = await resolveMedication({
    spoken: it.name || it.spokenText,
    strength: it.strength,
    dosageForm: it.dosageForm,
  });

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
    fieldStates: { ...it.fieldStates, isAlternative: it.isAlternative } as unknown as Prisma.InputJsonValue,
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
            // Source spans survive an edit: provenance belongs to what was SAID,
            // not to whether the doctor later adjusted the value.
            sourceText: it.sourceText ?? was?.sourceText ?? null,
            sourceStart: it.sourceStart ?? was?.sourceStart ?? null,
            sourceEnd: it.sourceEnd ?? was?.sourceEnd ?? null,
            fieldStates: (was?.fieldStates as Prisma.InputJsonValue) ?? Prisma.DbNull,
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

export async function sign(
  id: string,
  userId: string,
  opts: { isTelemedicine?: boolean; ip?: string; userAgent?: string } = {},
) {
  const rx = await prisma.prescription.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, status: true, branchId: true, visitId: true, clinicDoctorId: true,
      items: { select: ITEM_SELECT },
    },
  });
  if (!rx) throw new PrescriptionStateError('Prescription not found');
  if (rx.status === 'SIGNED') throw new PrescriptionStateError('Already signed');
  if (rx.status === 'SUPERSEDED') throw new PrescriptionStateError('This revision has been superseded');

  // The gate. Refusing here, not in the UI, is what makes PART 29 real.
  const validation = await validatePrescription({
    items: toValidatable(rx.items),
    isTelemedicine: !!opts.isTelemedicine,
  });
  if (!validation.canSign) {
    const blocking = validation.findings.filter((f) => f.severity !== 'NOTE');
    throw new PrescriptionStateError(
      `Cannot sign — ${blocking.length} item(s) need attention: ${blocking.map((f) => f.message).join(' | ')}`,
    );
  }

  const [doctor, visit] = await Promise.all([
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
  };

  await prisma.prescription.update({
    where: { id },
    data: {
      status: 'SIGNED',
      signedAt,
      signedByUserId: userId,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });

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

  const next = await prisma.$transaction(async (tx) => {
    await tx.prescription.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', isLatest: false } });

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

/** Unsigned drafts for a doctor — the amber strip on the queue. */
export async function listDrafts(clinicDoctorId: string, branchId: string) {
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
    where: { visit: { patientId }, status: 'SIGNED', isLatest: true, deletedAt: null },
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

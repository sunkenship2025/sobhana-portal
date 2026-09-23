/**
 * Prescriptions — draft, edit, validate, sign, revise, send.
 *
 * The state machine lives in prescriptionService; this file is transport plus
 * authorisation. Two rules are enforced here and nowhere else:
 *
 *  1. Only the CONSULTING DOCTOR of a visit (or an owner) may touch its
 *     prescription. A doctor cannot sign for a colleague.
 *  2. Sending requires SIGNED. This is the backend half of PART 29 — an AI draft
 *     can never reach a patient, regardless of what any frontend does.
 */
import { Router } from 'express';
import multer from 'multer';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { transcribeWithFallback, availableProviders, AsrUnavailable } from '../services/voiceRx/asr';
import { extractPrescription, extractionConfigured, ExtractionUnavailable } from '../services/voiceRx/extract';
import { resolveMedication, searchMedications, buildAsrHint } from '../services/voiceRx/resolver';
import {
  createDraft, updateDraft, sign, amend, getById, listDrafts, listForVisit,
  validateById, PrescriptionStateError,
} from '../services/voiceRx/prescriptionService';
import { putObject, deleteObject } from '../services/r2StorageService';
import { logAction } from '../services/auditService';
import {
  transcribeBurstLimit, consumeBranchQuota, checkAudio, checkDuration, recordUsage,
  DAILY_BRANCH_LIMIT, MAX_AUDIO_SECONDS,
} from '../services/voiceRx/quota';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);

/** Doctors and owners. Staff never write prescriptions — that is the whole point. */
const PRESCRIBERS = ['doctor', 'owner'] as const;

/**
 * A consultation's audio. 25 MB is well above a 90-second clip at any sane
 * bitrate and below the limits both ASR vendors accept.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Authorisation helper
// ---------------------------------------------------------------------------

/** The ClinicDoctor this login IS, or null for staff/owner without one. */
async function myClinicDoctorId(userId: string): Promise<string | null> {
  const cd = await prisma.clinicDoctor.findFirst({
    where: { userId, isActive: true },
    select: { id: true },
  });
  return cd?.id ?? null;
}

/**
 * May this user act on this prescription?
 *
 * An owner may (they run the clinic and must be able to unstick a visit). A
 * doctor may only act on their OWN — signing carries their name and registration
 * number, so it cannot be delegated.
 */
async function canAct(req: AuthRequest, clinicDoctorId: string): Promise<boolean> {
  if (req.user?.role === 'owner') return true;
  const mine = await myClinicDoctorId(req.user!.id);
  return !!mine && mine === clinicDoctorId;
}

const stateError = (res: any, err: unknown) => {
  if (err instanceof PrescriptionStateError) {
    res.status(409).json({ error: 'INVALID_STATE', message: err.message });
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// GET /api/prescriptions/capabilities — what this deployment can actually do
// Drives the UI: no keys configured means the mic is hidden, not broken.
// ---------------------------------------------------------------------------
router.get('/capabilities', async (_req: AuthRequest, res) => {
  const asr = availableProviders();
  res.json({
    asr,
    asrConfigured: asr.some((p) => p.configured),
    extractionConfigured: extractionConfigured(),
    voiceEnabled: asr.some((p) => p.configured) && extractionConfigured(),
    limits: { dailyPerBranch: DAILY_BRANCH_LIMIT, maxAudioSeconds: MAX_AUDIO_SECONDS },
  });
});

// ---------------------------------------------------------------------------
// GET /api/prescriptions/drafts — my unsigned prescriptions (the amber strip)
// ---------------------------------------------------------------------------
router.get('/drafts', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const cdId = await myClinicDoctorId(req.user!.id);
    if (!cdId) { res.json([]); return; }
    const rows = await listDrafts(cdId, req.branchId!);
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'prescriptions: list drafts failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load drafts' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/prescriptions/medications?q= — the picker
//
// Full names, never truncated, and the client must not auto-select the top hit.
// Juxtaposition error (picking the entry next to the one meant) was reported as
// a lived failure by 18 of 23 prescribers in one study.
// ---------------------------------------------------------------------------
router.get('/medications', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) { res.json({ resolution: 'UNRESOLVED', match: null, candidates: [] }); return; }

    // Typeahead mode: browsing the catalogue as the doctor types. Ranked by how
    // literally the text matches, not by what we guess they meant.
    if (req.query.mode === 'search') {
      const results = await searchMedications(q, Number(req.query.limit ?? 12));
      res.json({ resolution: 'MANUAL', match: null, candidates: results });
      return;
    }
    const result = await resolveMedication({
      spoken: q,
      strength: req.query.strength ? String(req.query.strength) : null,
      dosageForm: req.query.form ? String(req.query.form) : null,
    });
    // The picker always shows options — even a confident match is offered, never
    // committed on the user's behalf.
    const candidates = result.match && result.candidates.length === 0 ? [result.match] : result.candidates;
    res.json({ ...result, candidates });
  } catch (err) {
    logger.error({ err }, 'prescriptions: medication search failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Medicine lookup failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prescriptions/transcribe — audio -> transcript -> structured draft
//
// Returns the draft WITHOUT persisting it, so an accidental mic press leaves no
// record. The doctor gets a structured proposal; saving is a separate, deliberate
// call.
// ---------------------------------------------------------------------------
router.post('/transcribe', requireRole(...PRESCRIBERS), transcribeBurstLimit, upload.single('audio'), async (req: AuthRequest, res) => {
  const started = Date.now();
  try {
    if (!req.file?.buffer?.length) {
      res.status(400).json({ error: 'NO_AUDIO', message: 'No audio received' }); return;
    }

    // Size and type, before anything is sent to a paid API.
    const audioCheck = checkAudio(req.file.buffer.length, req.file.mimetype);
    if (!audioCheck.ok) {
      res.status(413).json({ error: 'AUDIO_REJECTED', message: audioCheck.reason }); return;
    }

    // The clinic's day. Exceeding it hides the mic; it never blocks prescribing,
    // because an accelerator that can halt the car is a defect.
    const quota = await consumeBranchQuota(req.branchId!);
    if (quota.exceeded) {
      logger.warn({ branchId: req.branchId, used: quota.used }, 'voiceRx: branch daily quota exceeded');
      res.status(429).json({
        error: 'VOICE_QUOTA_EXCEEDED',
        message: `This clinic has used its ${quota.limit} dictations for today. You can still type the prescription.`,
        quota,
      });
      return;
    }

    const provider = req.body?.provider ? String(req.body.provider) : undefined;
    // The clinic's own vocabulary as a decoder hint — the cheapest accuracy gain
    // available, and it targets exactly the tokens that matter.
    const hint = await buildAsrHint();

    const transcript = await transcribeWithFallback(req.file.buffer, req.file.originalname || 'audio.webm', {
      provider,
      prompt: hint || undefined,
    });

    // Duration is the real cost control — both providers bill per second — and it
    // is only knowable after the provider decodes the file.
    const durationCheck = checkDuration(transcript.durationSec);
    if (!durationCheck.ok) {
      res.status(413).json({ error: 'AUDIO_TOO_LONG', message: durationCheck.reason }); return;
    }

    if (!transcript.text.trim()) {
      res.status(422).json({
        error: 'EMPTY_TRANSCRIPT',
        message: 'Nothing was heard. Check the microphone and try again.',
        transcript,
      }); return;
    }

    const extraction = await extractPrescription(transcript.text, transcript.segments);

    // One attributable line per paid call, so spend has an owner.
    recordUsage({
      branchId: req.branchId!, userId: req.user!.id,
      provider: transcript.provider, model: transcript.model,
      durationSec: transcript.durationSec, extractionModel: extraction.model, quota,
    });

    logger.info(
      { ms: Date.now() - started, provider: transcript.provider, items: extraction.items.length },
      'prescriptions: transcribe+extract complete',
    );

    res.json({
      transcript: {
        text: transcript.text,
        segments: transcript.segments,
        language: transcript.language,
        provider: transcript.provider,
        model: transcript.model,
        durationSec: transcript.durationSec,
      },
      extraction: {
        items: extraction.items,
        diagnosis: extraction.diagnosis,
        notes: extraction.notes,
        followUpDays: extraction.followUpDays,
        missing: extraction.missing,
        model: extraction.model,
      },
      tookMs: Date.now() - started,
      quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining },
    });
  } catch (err: any) {
    if (err instanceof AsrUnavailable) {
      // Never a blank screen: the typed editor is always the fallback.
      res.status(503).json({
        error: 'ASR_UNAVAILABLE',
        message: 'Speech recognition is unavailable. You can still type the prescription.',
        detail: err.message,
      }); return;
    }
    if (err instanceof ExtractionUnavailable) {
      res.status(503).json({
        error: 'EXTRACTION_UNAVAILABLE',
        message: 'Could not structure the dictation. The transcript is below — you can type from it.',
        detail: err.message,
      }); return;
    }
    logger.error({ err }, 'prescriptions: transcribe failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Transcription failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prescriptions — create a draft (voice-seeded or empty/typed)
// ---------------------------------------------------------------------------
router.post('/', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const b = req.body ?? {};
    const visitId = String(b.visitId ?? '').trim();
    if (!visitId) { res.status(400).json({ error: 'BAD_REQUEST', message: 'visitId is required' }); return; }

    const visit = await prisma.visit.findFirst({
      where: { id: visitId, branchId: req.branchId! },
      select: { id: true, branchId: true, clinicVisit: { select: { clinicDoctorId: true } } },
    });
    if (!visit) { res.status(404).json({ error: 'NOT_FOUND', message: 'Visit not found' }); return; }

    const clinicDoctorId = visit.clinicVisit?.clinicDoctorId;
    if (!clinicDoctorId) {
      res.status(400).json({ error: 'NOT_A_CONSULTATION', message: 'This visit has no consulting doctor' }); return;
    }
    if (!(await canAct(req, clinicDoctorId))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'This is another doctor’s consultation' }); return;
    }

    // One open draft per visit — a second would split the doctor's attention and
    // is always a double-submit rather than an intention.
    const existing = await prisma.prescription.findFirst({
      where: { visitId, status: 'DRAFT', deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      res.status(200).json(await getById(existing.id)); return;
    }

    const created = await createDraft({
      visitId,
      clinicDoctorId,
      branchId: visit.branchId,
      userId: req.user!.id,
      transcript: b.transcript ?? null,
      transcriptSegments: b.transcriptSegments ?? null,
      asrProvider: b.asrProvider ?? null,
      asrModel: b.asrModel ?? null,
      asrLanguage: b.asrLanguage ?? null,
      extractionModel: b.extractionModel ?? null,
      audioKey: b.audioKey ?? null,
      audioDurationSec: b.audioDurationSec ?? null,
      diagnosis: b.diagnosis ?? null,
      notes: b.notes ?? null,
      followUpDays: b.followUpDays ?? null,
      items: Array.isArray(b.items) ? b.items : [],
    });

    res.status(201).json(created);
  } catch (err) {
    if (stateError(res, err)) return;
    logger.error({ err }, 'prescriptions: create failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not create the prescription' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/prescriptions?visitId= — every prescription on a visit
// ---------------------------------------------------------------------------
router.get('/', async (req: AuthRequest, res) => {
  try {
    const visitId = String(req.query.visitId ?? '').trim();
    if (!visitId) { res.status(400).json({ error: 'BAD_REQUEST', message: 'visitId is required' }); return; }
    res.json(await listForVisit(visitId));
  } catch (err) {
    logger.error({ err }, 'prescriptions: list failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load prescriptions' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/prescriptions/:id  (+ /validate)
// ---------------------------------------------------------------------------
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const rx = await getById(req.params.id);
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    res.json(rx);
  } catch (err) {
    logger.error({ err }, 'prescriptions: get failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load the prescription' });
  }
});

router.get('/:id/validate', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    res.json(await validateById(req.params.id, req.query.telemedicine === 'true'));
  } catch (err) {
    if (stateError(res, err)) return;
    logger.error({ err }, 'prescriptions: validate failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Validation failed' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/prescriptions/:id — edit a DRAFT
// ---------------------------------------------------------------------------
router.patch('/:id', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const rx = await prisma.prescription.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { clinicDoctorId: true },
    });
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    if (!(await canAct(req, rx.clinicDoctorId))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'This is another doctor’s prescription' }); return;
    }

    const updated = await updateDraft(req.params.id, req.user!.id, {
      diagnosis: req.body?.diagnosis,
      notes: req.body?.notes,
      followUpDays: req.body?.followUpDays,
      items: Array.isArray(req.body?.items) ? req.body.items : undefined,
    });
    res.json(updated);
  } catch (err) {
    if (stateError(res, err)) return;
    logger.error({ err }, 'prescriptions: update failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save the prescription' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prescriptions/:id/sign — the irreversible transition
//
// Optionally completes the visit in the same call ("Sign & next"): the doctor is
// the authority on whether the consultation is over. Staff keep their own
// Mark Done, and neither path requires the other.
// ---------------------------------------------------------------------------
router.post('/:id/sign', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const rx = await prisma.prescription.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { clinicDoctorId: true, visitId: true },
    });
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    if (!(await canAct(req, rx.clinicDoctorId))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Only the consulting doctor can sign this' }); return;
    }

    const signed = await sign(req.params.id, req.user!.id, {
      isTelemedicine: req.body?.isTelemedicine === true,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    });

    // Queue state is a SEPARATE machine — nudged, never required.
    let visitCompleted = false;
    if (req.body?.completeVisit === true) {
      await prisma.clinicVisit.updateMany({
        where: { visitId: rx.visitId, status: { not: 'COMPLETED' } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await prisma.visit.updateMany({
        where: { id: rx.visitId, status: { not: 'COMPLETED' } },
        data: { status: 'COMPLETED' },
      });
      visitCompleted = true;
    }

    res.json({ ...signed, visitCompleted });
  } catch (err) {
    if (stateError(res, err)) return;
    logger.error({ err }, 'prescriptions: sign failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not sign the prescription' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/prescriptions/:id/amend — correct a SIGNED one by revision
// ---------------------------------------------------------------------------
router.post('/:id/amend', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const rx = await prisma.prescription.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { clinicDoctorId: true },
    });
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    if (!(await canAct(req, rx.clinicDoctorId))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Only the consulting doctor can revise this' }); return;
    }
    res.json(await amend(req.params.id, req.user!.id, String(req.body?.reason ?? '')));
  } catch (err) {
    if (stateError(res, err)) return;
    logger.error({ err }, 'prescriptions: amend failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not revise the prescription' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/prescriptions/:id — discard a DRAFT (soft)
// A signed prescription is never deleted; it is superseded.
// ---------------------------------------------------------------------------
router.delete('/:id', requireRole(...PRESCRIBERS), async (req: AuthRequest, res) => {
  try {
    const rx = await prisma.prescription.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { clinicDoctorId: true, status: true, branchId: true, audioKey: true },
    });
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    if (rx.status !== 'DRAFT') {
      res.status(409).json({ error: 'INVALID_STATE', message: 'A signed prescription cannot be deleted' }); return;
    }
    if (!(await canAct(req, rx.clinicDoctorId))) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'This is another doctor’s draft' }); return;
    }

    await prisma.prescription.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });

    // Discarding a draft discards its audio too — there is no reason to keep
    // recorded speech for a prescription that was never issued.
    if (rx.audioKey) {
      deleteObject(rx.audioKey).catch((err) => logger.error({ err }, 'prescriptions: audio delete failed'));
    }

    await logAction({
      branchId: rx.branchId,
      actionType: 'DELETE',
      entityType: 'Prescription',
      entityId: req.params.id,
      userId: req.user!.id,
      oldValues: { status: rx.status },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'prescriptions: delete failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not discard the draft' });
  }
});

export default router;
export { myClinicDoctorId, upload as prescriptionAudioUpload, putObject as _putObject };

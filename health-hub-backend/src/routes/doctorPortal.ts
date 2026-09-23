/**
 * The doctor portal's own surfaces: my queue, my patients, my account.
 *
 * WHAT MAKES THIS FILE DIFFERENT FROM THE STAFF ROUTES
 * Every response here is PROJECTED, not filtered in the client. Three endpoints
 * the doctor legitimately needs leak money in their existing form —
 * `/visits/clinic/:id` returns consultationFeeInPaise, `/clinic-doctors/:id`
 * returns commissionPercent, and the Patient 360 summary returns
 * outstandingDueInPaise. A hidden div is still a payload, and the payload is what
 * leaks, so the doctor-scoped shapes below never contain those fields at all.
 *
 * ACCESS SCOPE
 * A doctor sees the patients they have a care relationship with. Anything else is
 * break-the-glass: a stated reason, audited, owner-readable. Every documented
 * clinical-privacy incident on record was standing access misused, never a
 * break-in, and the regulators' remedy afterwards was always narrower access.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAction } from '../services/auditService';
import { emitBranchChange, emitWorklistOnMutation } from '../lib/displayEvents';
import { listForPatient, currentMedications } from '../services/voiceRx/prescriptionService';
import { requireDigitalRx } from '../lib/clinicModule';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('doctor', 'owner'));
// The owner's master switch, same gate the prescriptions router carries. Off, and
// the doctor portal does not exist as far as the API is concerned; the clinic runs
// the old staff queue + pre-printed pad, which reads none of this.
router.use(requireDigitalRx);
// The doctor's queue is the SAME ClinicVisit rows the staff OP/IP queue and the
// waiting-room TV read, so a transition made here has to wake them exactly as a
// transition made there does. Without this the row moved and every other open
// screen went on showing the old one — the link was real in the database and
// invisible on the floor.
router.use(emitWorklistOnMutation);

/** Diagnostics are OFF by default. One org-wide row, shipped "false". */
const DIAGNOSTICS_KEY = 'doctor_view_diagnostics';

async function diagnosticsVisible(): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key: DIAGNOSTICS_KEY } });
  return row?.value === 'true';
}

async function meAsDoctor(userId: string) {
  return prisma.clinicDoctor.findFirst({
    where: { userId, isActive: true },
    // NOTE the absent fields: commissionType, commissionPercent,
    // commissionAmountInPaise, consultationFeeInPaise. A doctor must never be
    // able to read their own commission terms from the product.
    select: {
      id: true, doctorNumber: true, name: true, qualification: true, specialty: true,
      registrationNumber: true, phone: true, email: true, letterheadNote: true,
      signatureImageBase64: true, hprId: true,
    },
  });
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
  const y = now.getFullYear() - p.yearOfBirth;
  return p.ageUnit === 'DAYS' ? `${y} d` : p.ageUnit === 'MONTHS' ? `${y} m` : `${y} y`;
}

// ---------------------------------------------------------------------------
// GET /api/doctor/me
// ---------------------------------------------------------------------------
router.get('/me', async (req: AuthRequest, res) => {
  try {
    const doctor = await meAsDoctor(req.user!.id);
    if (!doctor && req.user!.role === 'doctor') {
      // A doctor login with no ClinicDoctor is a configuration gap, not a crash.
      // Say so plainly instead of rendering an empty portal.
      res.status(409).json({
        error: 'NO_CLINIC_DOCTOR',
        message: 'This login is not linked to a consulting doctor yet. Ask the owner to link it in Config → Signing.',
      }); return;
    }
    res.json({
      doctor,
      diagnosticsVisible: await diagnosticsVisible(),
      branch: { id: req.branchId! },
    });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: me failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load your profile' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/doctor/queue — the existing OP/IP queue, scoped and de-monetised
// ---------------------------------------------------------------------------
router.get('/queue', async (req: AuthRequest, res) => {
  try {
    const doctor = await meAsDoctor(req.user!.id);
    // An owner opening the doctor portal sees every consultation; a doctor sees
    // only their own.
    const doctorFilter = doctor ? { clinicDoctorId: doctor.id } : {};

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const rows = await prisma.clinicVisit.findMany({
      where: {
        ...doctorFilter,
        visit: { branchId: req.branchId!, status: { not: 'CANCELLED' } },
        OR: [
          { status: { in: ['WAITING', 'IN_PROGRESS'] } },
          { status: 'COMPLETED', completedAt: { gte: startOfDay } },
        ],
      },
      select: {
        id: true, visitId: true, visitType: true, hospitalWard: true, status: true,
        tokenNumber: true, startedAt: true, completedAt: true, createdAt: true, isRevisit: true,
        clinicDoctor: { select: { id: true, name: true } },
        visit: {
          select: {
            id: true, createdAt: true,
            patient: {
              select: {
                id: true, patientNumber: true, name: true, title: true, gender: true,
                yearOfBirth: true, dateOfBirth: true, ageUnit: true, deceasedAt: true,
              },
            },
            prescriptions: {
              where: { deletedAt: null, isLatest: true },
              select: { id: true, status: true },
            },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { tokenNumber: 'asc' }, { createdAt: 'asc' }],
    });

    // Shape deliberately: no consultationFeeInPaise, no paymentStatus, no bill.
    const queue = rows.map((r) => ({
      clinicVisitId: r.id,
      visitId: r.visitId,
      visitType: r.visitType,
      ward: r.hospitalWard,
      status: r.status,
      tokenNumber: r.tokenNumber,
      isRevisit: r.isRevisit,
      waitingSince: r.createdAt,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      doctorName: r.clinicDoctor.name,
      patient: {
        id: r.visit.patient.id,
        patientNumber: r.visit.patient.patientNumber,
        name: r.visit.patient.name,
        title: r.visit.patient.title,
        gender: r.visit.patient.gender,
        ageLabel: ageLabel(r.visit.patient),
        deceased: !!r.visit.patient.deceasedAt,
      },
      prescription: r.visit.prescriptions[0]
        ? { id: r.visit.prescriptions[0].id, status: r.visit.prescriptions[0].status }
        : null,
    }));

    res.json({
      queue,
      counts: {
        waiting: queue.filter((q) => q.status === 'WAITING').length,
        inProgress: queue.filter((q) => q.status === 'IN_PROGRESS').length,
        doneToday: queue.filter((q) => q.status === 'COMPLETED').length,
      },
    });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: queue failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load the queue' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/doctor/queue/next — call the next waiting patient
//
// One action, three effects: the row goes IN_PROGRESS, the waiting-room display
// picks it up from the same ClinicVisit row it already reads, and the composer
// opens. The doctor and the TV agree on the number the patient heard called.
// ---------------------------------------------------------------------------
router.post('/queue/next', async (req: AuthRequest, res) => {
  try {
    const doctor = await meAsDoctor(req.user!.id);
    if (!doctor) { res.status(409).json({ error: 'NO_CLINIC_DOCTOR', message: 'Not linked to a consulting doctor' }); return; }

    const next = await prisma.clinicVisit.findFirst({
      where: {
        clinicDoctorId: doctor.id,
        status: 'WAITING',
        visit: { branchId: req.branchId!, status: { not: 'CANCELLED' } },
      },
      orderBy: [{ tokenNumber: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, visitId: true },
    });
    if (!next) { res.status(404).json({ error: 'QUEUE_EMPTY', message: 'Nobody is waiting' }); return; }

    await prisma.clinicVisit.update({
      where: { id: next.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });
    await prisma.visit.updateMany({
      where: { id: next.visitId, status: 'WAITING' },
      data: { status: 'IN_PROGRESS' },
    });
    // The TV listens on the branch channel, not the worklist one, and its 25s
    // heartbeat carries no state. Without this the token the doctor just called
    // stays off the screen the waiting patients are watching.
    emitBranchChange(req.branchId!);

    res.json({ visitId: next.visitId, clinicVisitId: next.id });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: call next failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not call the next patient' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/doctor/queue/:visitId — start / complete
//
// The doctor's own copy of the transitions staff already have. Neither replaces
// the other: staff keep Start and Mark Done, and both paths stay live.
// ---------------------------------------------------------------------------
router.patch('/queue/:visitId', async (req: AuthRequest, res) => {
  try {
    const status = String(req.body?.status ?? '');
    if (!['IN_PROGRESS', 'COMPLETED'].includes(status)) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'status must be IN_PROGRESS or COMPLETED' }); return;
    }

    const cv = await prisma.clinicVisit.findFirst({
      where: { visitId: req.params.visitId, visit: { branchId: req.branchId! } },
      select: { id: true, clinicDoctorId: true, status: true },
    });
    if (!cv) { res.status(404).json({ error: 'NOT_FOUND', message: 'Visit not found' }); return; }

    const doctor = await meAsDoctor(req.user!.id);
    if (doctor && cv.clinicDoctorId !== doctor.id) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'This is another doctor’s consultation' }); return;
    }

    await prisma.clinicVisit.update({
      where: { id: cv.id },
      data: {
        status: status as any,
        ...(status === 'IN_PROGRESS' && !cv.status.includes('IN_PROGRESS') ? { startedAt: new Date() } : {}),
        ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
    await prisma.visit.updateMany({ where: { id: req.params.visitId }, data: { status: status as any } });
    if (cv.status !== status) emitBranchChange(req.branchId!);

    res.json({ ok: true, status });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: queue transition failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not update the visit' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/doctor/visits/:visitId — doctor-safe consultation context
//
// The existing GET /visits/clinic/:id returns consultationFeeInPaise, and it is
// the endpoint the prescription print page already calls. This is the same visit
// with money projected out — not hidden, absent.
// ---------------------------------------------------------------------------
router.get('/visits/:visitId', async (req: AuthRequest, res) => {
  try {
    const visit = await prisma.visit.findFirst({
      where: { id: req.params.visitId, branchId: req.branchId! },
      select: {
        id: true, status: true, createdAt: true,
        branch: { select: { id: true, name: true, address: true, phone: true } },
        patient: {
          select: {
            id: true, patientNumber: true, name: true, title: true, gender: true,
            yearOfBirth: true, dateOfBirth: true, ageUnit: true, deceasedAt: true,
            identifiers: { where: { type: 'PHONE' }, select: { value: true }, take: 1 },
          },
        },
        clinicVisit: {
          select: {
            id: true, visitType: true, hospitalWard: true, status: true, tokenNumber: true,
            clinicDoctor: {
              // No commission fields. Ever.
              select: { id: true, name: true, qualification: true, specialty: true, registrationNumber: true, letterheadNote: true },
            },
          },
        },
      },
    });
    if (!visit || !visit.clinicVisit) { res.status(404).json({ error: 'NOT_FOUND', message: 'Consultation not found' }); return; }

    const doctor = await meAsDoctor(req.user!.id);
    if (doctor && visit.clinicVisit.clinicDoctor.id !== doctor.id) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'This is another doctor\u2019s consultation' }); return;
    }

    const [prescriptions, current] = await Promise.all([
      listForPatient(visit.patient.id, 6),
      currentMedications(visit.patient.id),
    ]);

    res.json({
      visit: {
        id: visit.id,
        status: visit.status,
        date: visit.createdAt,
        visitType: visit.clinicVisit.visitType,
        ward: visit.clinicVisit.hospitalWard,
        queueStatus: visit.clinicVisit.status,
        tokenNumber: visit.clinicVisit.tokenNumber,
      },
      branch: visit.branch,
      doctor: visit.clinicVisit.clinicDoctor,
      patient: {
        id: visit.patient.id,
        patientNumber: visit.patient.patientNumber,
        name: visit.patient.name,
        title: visit.patient.title,
        gender: visit.patient.gender,
        ageLabel: ageLabel(visit.patient),
        phone: visit.patient.identifiers[0]?.value ?? null,
        deceased: !!visit.patient.deceasedAt,
      },
      // Prescription history is the ONLY clinical context this database has, and
      // it is the one a prescriber most needs: what are they already taking.
      previousPrescriptions: prescriptions,
      currentMedications: current,
    });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: visit context failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load the consultation' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/doctor/patients?q= — search
// ---------------------------------------------------------------------------
router.get('/patients', async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2) { res.json([]); return; }

    const patients = await prisma.patient.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { patientNumber: { contains: q, mode: 'insensitive' } },
          { identifiers: { some: { value: { contains: q } } } },
        ],
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, patientNumber: true, name: true, title: true, gender: true,
        yearOfBirth: true, dateOfBirth: true, ageUnit: true, deceasedAt: true,
      },
    });

    const doctor = await meAsDoctor(req.user!.id);
    // Flag the care relationship rather than hiding the row. A doctor searching
    // for a patient they have not seen should be told so and asked why — not
    // met with a silent empty result that teaches them to distrust search.
    const mine = doctor
      ? new Set(
          (
            await prisma.visit.findMany({
              where: { patientId: { in: patients.map((p) => p.id) }, clinicVisit: { clinicDoctorId: doctor.id } },
              select: { patientId: true },
              distinct: ['patientId'],
            })
          ).map((v) => v.patientId),
        )
      : new Set(patients.map((p) => p.id));

    res.json(
      patients.map((p) => ({
        id: p.id,
        patientNumber: p.patientNumber,
        name: p.name,
        title: p.title,
        gender: p.gender,
        ageLabel: ageLabel(p),
        deceased: !!p.deceasedAt,
        myPatient: mine.has(p.id),
      })),
    );
  } catch (err) {
    logger.error({ err }, 'doctorPortal: patient search failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Search failed' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/doctor/patients/:id — the clinical 360, money removed
// ---------------------------------------------------------------------------
router.get('/patients/:id', async (req: AuthRequest, res) => {
  try {
    const patient = await prisma.patient.findUnique({
      where: { id: req.params.id },
      select: {
        id: true, patientNumber: true, name: true, title: true, gender: true,
        yearOfBirth: true, dateOfBirth: true, ageUnit: true, deceasedAt: true,
        identifiers: { where: { type: 'PHONE' }, select: { value: true }, take: 1 },
      },
    });
    if (!patient) { res.status(404).json({ error: 'NOT_FOUND', message: 'Patient not found' }); return; }

    const doctor = await meAsDoctor(req.user!.id);

    // Care relationship, or an explicit break-glass reason on this request.
    let related = true;
    if (doctor) {
      const seen = await prisma.visit.findFirst({
        where: { patientId: patient.id, clinicVisit: { clinicDoctorId: doctor.id } },
        select: { id: true },
      });
      related = !!seen;
    }
    const reason = String(req.query.reason ?? '').trim();
    if (!related && !reason) {
      res.status(428).json({
        error: 'BREAK_GLASS_REQUIRED',
        message: 'You have not treated this patient. State why you need their record.',
        patient: { name: patient.name, patientNumber: patient.patientNumber },
      }); return;
    }
    if (!related && reason) {
      await logAction({
        branchId: req.branchId!,
        actionType: 'BREAK_GLASS',
        entityType: 'Patient',
        entityId: patient.id,
        userId: req.user!.id,
        ipAddress: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
        newValues: { reason, doctor: doctor?.name ?? null, patientNumber: patient.patientNumber },
      });
    }

    const showDiagnostics = await diagnosticsVisible();

    const visits = await prisma.visit.findMany({
      where: { patientId: patient.id },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        id: true, domain: true, status: true, createdAt: true,
        branch: { select: { id: true, name: true } },
        clinicVisit: {
          select: { visitType: true, hospitalWard: true, clinicDoctor: { select: { name: true } } },
        },
        prescriptions: {
          where: { deletedAt: null, isLatest: true, status: 'SIGNED' },
          select: { id: true, signedAt: true },
        },
        // Diagnostics only when the org has turned them on. `take: 0` makes the
        // database return nothing rather than us filtering after the fact — a
        // hidden field is still a payload, and the payload is what leaks.
        testOrders: {
          where: { cancelledAt: null },
          take: showDiagnostics ? 50 : 0,
          select: { id: true, workflowMode: true, product: { select: { name: true } }, test: { select: { name: true } } },
        },
      },
    });

    const [prescriptions, current] = await Promise.all([
      listForPatient(patient.id, 20),
      currentMedications(patient.id),
    ]);

    res.json({
      patient: {
        id: patient.id,
        patientNumber: patient.patientNumber,
        name: patient.name,
        title: patient.title,
        gender: patient.gender,
        ageLabel: ageLabel(patient),
        phone: patient.identifiers[0]?.value ?? null,
        deceased: !!patient.deceasedAt,
        deceasedAt: patient.deceasedAt,
      },
      // Money is absent by construction, not hidden: no due, no bill, no fee.
      glance: {
        lastConsultation: visits.find((v) => v.clinicVisit)?.createdAt ?? null,
        lastConsultationDoctor: visits.find((v) => v.clinicVisit)?.clinicVisit?.clinicDoctor?.name ?? null,
        consultations: visits.filter((v) => v.clinicVisit).length,
        prescriptions: prescriptions.length,
        currentlyOn: current.length,
      },
      currentMedications: current,
      // Cancelled visits STAY on the timeline, dimmed and badged — a doctor
      // reading history must see that a visit was cancelled, not find a hole.
      timeline: visits.map((v) => ({
        visitId: v.id,
        domain: v.domain,
        status: v.status,
        date: v.createdAt,
        branchName: v.branch.name,
        visitType: v.clinicVisit?.visitType ?? null,
        ward: v.clinicVisit?.hospitalWard ?? null,
        doctorName: v.clinicVisit?.clinicDoctor?.name ?? null,
        prescriptionId: v.prescriptions[0]?.id ?? null,
        tests: showDiagnostics ? (v.testOrders ?? []).map((t) => t.product?.name ?? t.test?.name).filter(Boolean) : undefined,
      })),
      prescriptions,
      diagnosticsVisible: showDiagnostics,
      breakGlass: !related,
    });
  } catch (err) {
    logger.error({ err }, 'doctorPortal: patient view failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load the patient' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/doctor/me — the doctor's OWN account
//
// Name, qualification, specialty and registration number are deliberately NOT
// editable here: they print on a legal document and drive payouts, so the owner
// owns them. A doctor who changes clinic must not be able to retype their own
// registration number.
// ---------------------------------------------------------------------------
router.patch('/me', async (req: AuthRequest, res) => {
  try {
    const doctor = await meAsDoctor(req.user!.id);
    if (!doctor) { res.status(409).json({ error: 'NO_CLINIC_DOCTOR', message: 'Not linked to a consulting doctor' }); return; }

    const data: Record<string, unknown> = {};
    if (typeof req.body?.signatureImageBase64 === 'string') data.signatureImageBase64 = req.body.signatureImageBase64;
    if (req.body?.signatureImageBase64 === null) data.signatureImageBase64 = null;
    if (typeof req.body?.letterheadNote === 'string') data.letterheadNote = req.body.letterheadNote;

    if (Object.keys(data).length === 0) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Nothing to update' }); return;
    }

    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data });
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ClinicDoctor',
      entityId: doctor.id,
      userId: req.user!.id,
      newValues: { fields: Object.keys(data) },
    });

    res.json(await meAsDoctor(req.user!.id));
  } catch (err) {
    logger.error({ err }, 'doctorPortal: update me failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save' });
  }
});

export default router;

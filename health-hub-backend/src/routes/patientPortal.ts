/**
 * Patient portal API — mounted at /api/patient. The second (patient) principal
 * of health-hub-backend; reuses staff services, adds no tables.
 *
 * Endpoints (design.md §4.3):
 *   POST /auth/request-otp   public   → 204 always (non-oracle)
 *   POST /auth/verify-otp    public   → sets pjwt, { profiles }
 *   POST /auth/logout        patient  → 204 (revokes the token)
 *   GET  /me                 patient  → { phone, profiles[] }
 *   GET  /overview           patient  → per-person buckets           (next step)
 *   GET  /reports/:id/pdf    patient  → application/pdf              (next step)
 *   GET  /bills/:visitId/pdf patient  → application/pdf              (next step)
 */

import { Router } from 'express';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { createRateLimiter, getClientIp } from '../middleware/rateLimit';
import {
  patientAuthMiddleware,
  signPatientToken,
  setPatientCookie,
  clearPatientCookie,
  revokePatientToken,
  type PatientRequest,
} from '../middleware/patientAuth';
import { normalizePhone, requestOtp, verifyOtp } from '../services/patientOtpService';
import { findPatientsByIdentifier } from '../services/patientMatchingService';
import { mapBillFinancials } from '../services/patientService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { generateMergedReportPdf, cacheVariantFor } from '../services/mergedReportPdfService';
import { getCachedMergedPdf } from '../services/mergedReportPdfCache';
import { createAccessToken } from '../services/reportAccessService';
import { generateBillPdf } from '../services/billPdfService';
import { checkLockout, recordFailedAttempt, clearAttempts } from '../lib/loginLockout';
import QRCode from 'qrcode';

// Origin serving the report/bill static assets (CSS, images, signatures) during a cold PDF
// render — the PUBLIC host, not api. (which is locked to /api/patient). Also keeps the
// portal's rendered PDF byte-identical to the public one (shared merged-pdf cache).
const PUBLIC_ORIGIN = (() => {
  try {
    return new URL(process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports').origin;
  } catch {
    return 'http://localhost:3000';
  }
})();

const router = Router();

// ---- rate limiters (F11) -------------------------------------------------
// General per-IP guard on every patient request.
const patientApiRateLimit = createRateLimiter({
  namespace: 'patient-api',
  windowMs: 60_000,
  maxRequests: 120,
  keyGenerator: (req) => [getClientIp(req)],
});
// Per-IP cap on OTP sends — blocks mass-spam / Meta-cost abuse across many numbers.
const patientOtpIpRateLimit = createRateLimiter({
  namespace: 'patient-otp-ip',
  windowMs: 10 * 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
});
// Per-phone cap — protects one patient's WhatsApp quota from repeated sends.
const patientOtpPhoneRateLimit = createRateLimiter({
  namespace: 'patient-otp-phone',
  windowMs: 10 * 60_000,
  maxRequests: 4,
  keyGenerator: (req) => [normalizePhone(String(req.body?.phone || '')) || 'invalid'],
});
// Per-phone cap on verify attempts — bounds brute-force AND keeps an attacker from
// driving the 12-fail lockout on a victim's number (5/10min stays under the threshold).
const patientOtpVerifyRateLimit = createRateLimiter({
  namespace: 'patient-otp-verify',
  windowMs: 10 * 60_000,
  maxRequests: 5,
  keyGenerator: (req) => [normalizePhone(String(req.body?.phone || '')) || 'invalid'],
});

router.use(patientApiRateLimit);

// ---- helpers -------------------------------------------------------------
function ageLabel(p: { dateOfBirth: Date | null; yearOfBirth: number | null }): string | null {
  const now = new Date();
  if (p.dateOfBirth) {
    let y = now.getFullYear() - p.dateOfBirth.getFullYear();
    const m = now.getMonth() - p.dateOfBirth.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < p.dateOfBirth.getDate())) y--;
    return `${Math.max(0, y)}y`;
  }
  if (p.yearOfBirth) return `${Math.max(0, now.getFullYear() - p.yearOfBirth)}y`;
  return null;
}

/** The person-card fields the Home wireframe needs: name + P-number + gender + age. */
async function loadProfiles(patientIds: string[]) {
  if (!patientIds.length) return [];
  const patients = await prisma.patient.findMany({
    where: { id: { in: patientIds } },
    select: {
      id: true,
      patientNumber: true,
      name: true,
      gender: true,
      dateOfBirth: true,
      yearOfBirth: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  return patients.map((p) => ({
    patientId: p.id,
    patientNumber: p.patientNumber,
    name: p.name,
    gender: p.gender,
    age: ageLabel(p),
  }));
}

const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // "New" badge (F19): finalized within 7 days
const IST_DATE = { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' } as const;
const fmtDate = (d: Date): string => d.toLocaleDateString('en-IN', IST_DATE); // "12 Aug 2026"

/** Test names for a visit — active orders only (cancelled excluded), display order. */
function testNames(
  orders: { testNameSnapshot: string; cancelledAt: Date | null; displayOrder: number }[],
): string {
  return orders
    .filter((o) => !o.cancelledAt)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((o) => o.testNameSnapshot)
    .join(', ');
}

/**
 * Per-person Reports / Awaiting-payment / On-the-way buckets — the /overview payload.
 * Bucketing keys off the FINALIZED report (BUILD-MAP decision: an owner can finalize
 * with a due, so "Reports" can carry a balance on its bill chip). No result values
 * are ever included — those live only in the PDF.
 */
async function buildOverview(patientIds: string[]) {
  const profiles = await loadProfiles(patientIds);
  if (!profiles.length) return [];

  const visits = await prisma.visit.findMany({
    // v1: diagnostics only. Clinic consultation visits are bill-only (no report) and
    // would mis-bucket as "results expected" — they get a dedicated "Consultations"
    // section in a later version. See docs/patient-portal/DECISIONS.md.
    where: { patientId: { in: patientIds }, status: { not: 'CANCELLED' }, domain: 'DIAGNOSTICS' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      patientId: true,
      createdAt: true,
      status: true,
      branch: { select: { name: true } },
      bill: {
        select: {
          paymentStatus: true,
          totalAmountInPaise: true,
          discountType: true,
          discountPercentage: true,
          discountAmountInPaise: true,
          discountReason: true,
          paidAmountInPaise: true,
          refundedAmountInPaise: true,
          reversedChargeInPaise: true,
          billedAt: true,
          billNumber: true,
        },
      },
      report: {
        select: {
          versions: {
            where: { status: 'FINALIZED' },
            select: { id: true, versionNum: true, finalizedAt: true },
            orderBy: { versionNum: 'desc' },
          },
        },
      },
      testOrders: { select: { testNameSnapshot: true, cancelledAt: true, displayOrder: true } },
    },
  });

  const buckets = new Map<
    string,
    { reports: any[]; awaitingPayment: any[]; onTheWay: any[] }
  >();
  for (const p of profiles) buckets.set(p.patientId, { reports: [], awaitingPayment: [], onTheWay: [] });

  for (const v of visits) {
    const b = buckets.get(v.patientId);
    if (!b) continue;
    const fin = mapBillFinancials(v.bill, v.status);
    const finalized = v.report?.versions?.[0]; // highest versionNum FINALIZED, if any
    const base = {
      visitId: v.id,
      date: fmtDate(v.createdAt),
      branch: v.branch?.name || '',
      tests: testNames(v.testOrders),
    };
    const bill = {
      hasBill: fin.hasBill,
      billNumber: v.bill?.billNumber || null,
      totalInPaise: fin.netAmountInPaise,
      paidInPaise: fin.paidAmountInPaise,
      dueInPaise: fin.dueAmountInPaise,
    };

    if (finalized) {
      const isNew = finalized.finalizedAt
        ? Date.now() - finalized.finalizedAt.getTime() < NEW_WINDOW_MS
        : false;
      b.reports.push({ ...base, reportVersionId: finalized.id, isNew, bill }); // bill.due may be >0 (owner override)
    } else if (fin.dueAmountInPaise > 0) {
      b.awaitingPayment.push({ ...base, bill });
    } else {
      b.onTheWay.push(base);
    }
  }

  return profiles.map((p) => ({ ...p, ...buckets.get(p.patientId)! }));
}

const INVALID_CODE = { error: 'INVALID_CODE', message: 'Invalid or expired code' }; // uniform (F12)

// ---- auth ----------------------------------------------------------------

// Always 204, and respond BEFORE doing any patient-only work — so response timing
// can't distinguish a patient (awaited WhatsApp send) from a non-patient (F12, no oracle).
router.post('/auth/request-otp', patientOtpIpRateLimit, patientOtpPhoneRateLimit, (req, res) => {
  const phone = normalizePhone(String(req.body?.phone || ''));
  res.status(204).end();
  if (phone) {
    requestOtp(phone).catch((err) => logger.error({ err }, 'patient request-otp failed'));
  }
});

router.post('/auth/verify-otp', patientOtpVerifyRateLimit, async (req, res) => {
  const phone = normalizePhone(String(req.body?.phone || ''));
  const code = String(req.body?.code || '');
  if (!phone) return res.status(401).json(INVALID_CODE); // uniform — no oracle

  const lockKey = `patient-otp:${phone}`;
  const lock = await checkLockout(lockKey);
  if (lock.locked) {
    res.setHeader('Retry-After', String(lock.retryAfterSec));
    return res.status(423).json({
      error: 'LOCKED',
      message: 'Too many attempts. Please try again shortly.',
      retryAfterSec: lock.retryAfterSec,
    });
  }

  const result = await verifyOtp(phone, code);
  if (result !== 'ok') {
    // Count a failure ONLY for a real wrong guess against a pending code — never for
    // 'none' (no OTP in flight), so verify-spam on a victim's number can't lock them out.
    if (result === 'wrong') await recordFailedAttempt(lockKey);
    return res.status(401).json(INVALID_CODE);
  }
  await clearAttempts(lockKey);

  const matches = await findPatientsByIdentifier({ phone }, { includeVisitHistory: false });
  const patientIds = matches.map((m) => m.patient.id);
  setPatientCookie(res, signPatientToken(phone));
  const profiles = await loadProfiles(patientIds);
  logger.info({ phoneTail: phone.slice(-4), profiles: profiles.length }, 'patient-login: success'); // F15
  return res.json({ profiles });
});

router.post('/auth/logout', patientAuthMiddleware, async (req: PatientRequest, res) => {
  await revokePatientToken(req.patient?.jti, req.patient?.exp);
  clearPatientCookie(res);
  return res.status(204).end();
});

router.get('/me', patientAuthMiddleware, async (req: PatientRequest, res) => {
  const profiles = await loadProfiles(req.patientIds || []);
  return res.json({ phone: req.patient!.phone, profiles });
});

// ---- data (next step) ----------------------------------------------------
router.get('/overview', patientAuthMiddleware, async (req: PatientRequest, res) => {
  const profiles = await buildOverview(req.patientIds || []);
  return res.json({ phone: req.patient!.phone, profiles });
});
// Stream a report PDF. Ownership re-proved from the document upward; a superseded
// version returns 410 → the "Report updated" screen. Reuses the shared render+cache
// (keyed by reportVersionId), minting a QR token only on a cold miss.
router.get('/reports/:reportVersionId/pdf', patientAuthMiddleware, async (req: PatientRequest, res) => {
  const { reportVersionId } = req.params;
  const download = req.query.download === '1';
  try {
    const version = await prisma.reportVersion.findUnique({
      where: { id: reportVersionId },
      select: {
        status: true,
        versionNum: true,
        report: {
          select: {
            visit: { select: { patientId: true, status: true, billNumber: true } },
            versions: { where: { status: 'FINALIZED' }, select: { versionNum: true } },
          },
        },
      },
    });
    const visit = version?.report?.visit;
    // Ownership re-proof — never trust the client.
    if (!version || !visit || !req.patientIds?.includes(visit.patientId) || visit.status === 'CANCELLED') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    if (version.status !== 'FINALIZED') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    const maxFinalized = Math.max(...version.report!.versions.map((v) => v.versionNum));
    if (version.versionNum < maxFinalized) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(410).json({ error: 'REPORT_SUPERSEDED' }); // → "Report updated"
    }

    // Load the snapshot (needed to render AND to compute the cache-variant key).
    const snapshot = await getReportSnapshot(reportVersionId);
    if (!snapshot) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    // Cache-first with the CORRECT variant (digital carries a name-flag variant) — a hit
    // skips both the render and the token mint. Only a true cold miss mints a QR token,
    // so we don't create a permanent public access token on every view.
    let buffer = await getCachedMergedPdf(reportVersionId, 'digital', cacheVariantFor(snapshot, 'digital'));
    if (!buffer) {
      const reportToken = await createAccessToken(reportVersionId);
      const reportUrl = `${process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports'}/${reportToken}`;
      const qrDataUrl = await QRCode.toDataURL(reportUrl, {
        width: 100,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      // baseUrl = public host (not the locked-down api.) so render assets resolve.
      buffer = await generateMergedReportPdf(snapshot, { mode: 'digital', baseUrl: PUBLIC_ORIGIN, qrDataUrl, cache: true });
    }

    prisma.reportAccessLog
      .create({
        data: {
          reportVersionId,
          accessType: download ? 'DOWNLOAD' : 'VIEW',
          accessedVia: 'PATIENT_PORTAL', // free-text column — no migration
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        },
      })
      .catch((err) => logger.warn({ err }, 'patient report access log failed'));

    const filename = `Report-${visit.billNumber || reportVersionId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'patient report pdf failed');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).end();
  }
});

// Stream a bill PDF. Ownership re-proved + status!=CANCELLED. Reuses generateBillPdf
// (its own content-addressed 7-day cache); no token → separate, un-poisoned cache entry.
router.get('/bills/:visitId/pdf', patientAuthMiddleware, async (req: PatientRequest, res) => {
  const { visitId } = req.params;
  const download = req.query.download === '1';
  try {
    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      select: { patientId: true, status: true, domain: true, billNumber: true },
    });
    if (!visit || !req.patientIds?.includes(visit.patientId) || visit.status === 'CANCELLED') {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    const baseUrl = PUBLIC_ORIGIN; // render assets load from the public host, not locked-down api.
    const result = await generateBillPdf(visitId, visit.domain as 'CLINIC' | 'DIAGNOSTICS', { baseUrl });
    if (!result) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).end();
    }
    const filename = `Bill-${visit.billNumber || visitId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (err) {
    logger.error({ err }, 'patient bill pdf failed');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).end();
  }
});

export default router;

/**
 * Waiting-room Display API (PUBLIC — no user auth)
 *
 * The TV polls this. The screen's random `code` (in the URL) IS the credential,
 * exactly like the report gateway (/r/:token). It is read-only and branch-scoped
 * by the DisplayScreen record, so it exposes nothing beyond the public queue:
 * each shown doctor's current token, who is now serving, and the patient name
 * that is already called out loud in the room.
 *
 *   GET /api/display/:code/state
 */
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { createRateLimiter, getClientIp } from '../middleware/rateLimit';
import { getObjectStream } from '../services/r2StorageService';
import QRCode from 'qrcode';
import { branchSlug } from '../lib/displaySlug';

// The track-your-token QR is stable per URL — generate once, then serve from cache.
const trackQrCache = new Map<string, string>();
async function trackQrDataUrl(url: string): Promise<string> {
  const cached = trackQrCache.get(url);
  if (cached) return cached;
  const dataUrl = await QRCode.toDataURL(url, {
    width: 240,
    margin: 1,
    color: { dark: '#1B2B58', light: '#ffffff' },
  });
  if (trackQrCache.size > 200) trackQrCache.clear();
  trackQrCache.set(url, dataUrl);
  return dataUrl;
}

const router = Router();

// A single TV polls ~every 2–3s (≈20–30/min). Allow a few screens behind one
// public IP before throttling.
const displayRateLimit = createRateLimiter({
  namespace: 'display-state',
  windowMs: 60_000,
  maxRequests: 150,
  keyGenerator: (req) => [getClientIp(req), String(req.params.code || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

/** UTC bounds of "today" in IST (the clinic's business day). */
function istDayRangeUtc(): { start: Date; end: Date } {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const start = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate()) -
      5.5 * 60 * 60 * 1000,
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

type Doc = {
  id: string;
  name: string;
  specialty: string;
  room: string | null;
  currentToken: number | null;
  tokenLabel: string | null;
  serving: boolean;
  patientName: string | null;
  startedAt: string | null;
  _at: number; // internal ranking timestamp, stripped before responding
};

function doctorInitials(name: string): string {
  const parts = name.replace(/^\s*dr\.?\s*/i, '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return 'DR';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function fmtTokenLabel(name: string, token: number | null): string | null {
  if (token == null) return null;
  return `${doctorInitials(name)}-${String(token).padStart(2, '0')}`;
}

router.get('/:branchSlug/:screenSlug/state', displayRateLimit, async (req: Request, res: Response) => {
  try {
    const bSlug = String(req.params.branchSlug || '').toLowerCase();
    const sSlug = String(req.params.screenSlug || '');

    const branches = await prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    });
    const branch = branches.find((b) => branchSlug(b.name, b.code) === bSlug);
    if (!branch) {
      return res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: "This screen link isn't recognized." });
    }
    const screen = await prisma.displayScreen.findFirst({
      where: {
        branchId: branch.id,
        isActive: true,
        revokedAt: null,
        OR: [{ slug: sSlug }, { code: sSlug }],
      },
    });
    if (!screen) {
      return res.status(404).json({ error: 'SCREEN_NOT_FOUND', message: "This screen link isn't recognized." });
    }

    const { start, end } = istDayRangeUtc();
    const visitTypes = screen.scope === 'OP_IP' ? ['OP', 'IP'] : ['OP'];

    const visits = await prisma.visit.findMany({
      where: {
        branchId: screen.branchId,
        domain: 'CLINIC',
        createdAt: { gte: start, lt: end },
        clinicVisit: {
          is: {
            visitType: { in: visitTypes as any },
            // Only actively-serving visits drive the board. Fetching the day's
            // WAITING/COMPLETED too meant every 2.5s poll re-allocated an
            // ever-growing array of visits it never used (memory climbed all day).
            status: 'IN_PROGRESS' as any,
          },
        },
      },
      select: {
        patient: { select: { name: true } },
        clinicVisit: {
          select: {
            clinicDoctorId: true,
            status: true,
            tokenNumber: true,
            startedAt: true,
            completedAt: true,
            clinicDoctor: {
              select: { id: true, name: true, specialty: true, roomLabel: true },
            },
          },
        },
      },
    });

    const filter = screen.doctorIds || [];
    const map = new Map<string, Doc>();

    for (const v of visits) {
      const cv = v.clinicVisit;
      if (!cv || !cv.clinicDoctor) continue;
      const docId = cv.clinicDoctorId;
      if (filter.length && !filter.includes(docId)) continue;

      let d = map.get(docId);
      if (!d) {
        const docName = cv.clinicDoctor.name;
        d = {
          id: docId,
          name: docName,
          specialty: cv.clinicDoctor.specialty,
          room: cv.clinicDoctor.roomLabel || null,
          currentToken: null,
          tokenLabel: null,
          serving: false,
          patientName: null,
          startedAt: null,
          _at: 0,
        };
        map.set(docId, d);
      }

      if (cv.status === 'IN_PROGRESS') {
        // Only doctors actively serving appear on the board. A cleared queue
        // (nobody in progress) shows nothing — no stale "last served" token.
        const t = cv.startedAt ? cv.startedAt.getTime() : 0;
        if (!d.serving || t >= d._at) {
          d.serving = true;
          d.currentToken = cv.tokenNumber ?? null;
          d.tokenLabel = fmtTokenLabel(d.name, cv.tokenNumber ?? null);
          d.patientName = v.patient?.name || null;
          d.startedAt = cv.startedAt ? cv.startedAt.toISOString() : null;
          d._at = t;
        }
      }
    }

    let doctors = Array.from(map.values());
    if (filter.length) {
      // Owner pinned specific doctors: keep that order and include ones with no
      // visits yet today (shown with a "—" token).
      const present = new Map(doctors.map((d) => [d.id, d]));
      const pinned = await prisma.clinicDoctor.findMany({
        where: { id: { in: filter } },
        select: { id: true, name: true, specialty: true, roomLabel: true },
      });
      doctors = pinned.map(
        (p) =>
          present.get(p.id) || {
            id: p.id,
            name: p.name,
            specialty: p.specialty,
            room: p.roomLabel || null,
            currentToken: null,
            tokenLabel: null,
            serving: false,
            patientName: null,
            startedAt: null,
            _at: 0,
          },
      );
    } else {
      doctors.sort((a, b) => a.name.localeCompare(b.name));
    }

    const serving = doctors.filter((d) => d.serving && d.startedAt);
    serving.sort((a, b) => (b.startedAt as string).localeCompare(a.startedAt as string));
    const top = serving[0] || null;
    const nowServing = top
      ? {
          doctorId: top.id,
          doctorName: top.name,
          specialty: top.specialty,
          room: top.room,
          token: top.currentToken,
          tokenLabel: top.tokenLabel,
          patientName: top.patientName,
          startedAt: top.startedAt,
        }
      : null;

    // Ads to rotate in the idle state: enabled + within any schedule window.
    const nowD = new Date();
    const ads = await prisma.displayAd.findMany({
      where: {
        branchId: screen.branchId,
        enabled: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: nowD } }] },
          { OR: [{ endDate: null }, { endDate: { gte: nowD } }] },
          { OR: [{ screenIds: { isEmpty: true } }, { screenIds: { has: screen.id } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const adsOut = ads.map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      fit: a.fit,
      durationSec: a.durationSec,
      weight: a.weight,
      media: a.mediaKeys.map((_k, i) => ({
        path: `/display/ads/media/${a.id}/${i}`,
        mimeType: a.mimeTypes[i] || 'application/octet-stream',
      })),
    }));

    // "Track your token" QR → the mobile companion at <frontend>/track/<code>.
    // The display's own origin (request Origin header) is the right frontend to
    // point at; fall back to FRONTEND_URL for non-browser callers.
    const origin =
      (req.headers.origin as string | undefined) || process.env.FRONTEND_URL || '';
    const trackUrl = origin
      ? `${origin.replace(/\/$/, '')}/track/${bSlug}/${screen.slug || screen.code}`
      : '';
    const trackQr = screen.showTrackQr && trackUrl ? await trackQrDataUrl(trackUrl) : '';

    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      screen: {
        id: screen.id,
        name: screen.name,
        holdSeconds: screen.holdSeconds,
        showTrackQr: screen.showTrackQr,
        chimeSound: screen.chimeSound,
      },
      branch: { name: branch.name, code: branch.code },
      scope: screen.scope,
      serverTime: new Date().toISOString(),
      doctors: doctors.map(({ _at, ...d }) => d),
      nowServing,
      ads: adsOut,
      trackUrl,
      trackQr,
    });
  } catch (err: any) {
    console.error('Display state error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load display state' });
  }
});

/**
 * PUBLIC ad media stream. Pipes the R2 object straight to the TV with Range
 * support (never buffers — safe for large videos). Long cache since a replaced
 * ad gets a new id/key.
 *
 *   GET /api/display/ads/media/:adId/:index
 */
router.get('/ads/media/:adId/:index', async (req: Request, res: Response) => {
  try {
    const idx = parseInt(String(req.params.index), 10);
    const ad = await prisma.displayAd.findUnique({ where: { id: String(req.params.adId) } });
    if (!ad || !ad.enabled || Number.isNaN(idx) || idx < 0 || idx >= ad.mediaKeys.length) {
      return res.status(404).end();
    }
    const obj = await getObjectStream(ad.mediaKeys[idx], req.headers.range);
    res.status(obj.status);
    if (obj.contentType) res.setHeader('Content-Type', obj.contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (obj.contentRange) res.setHeader('Content-Range', obj.contentRange);
    if (obj.contentLength != null) res.setHeader('Content-Length', String(obj.contentLength));
    obj.body.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.destroy();
    });
    obj.body.pipe(res);
    return;
  } catch (err: any) {
    console.error('Display media stream error:', err);
    if (!res.headersSent) res.status(500).end();
    return;
  }
});

export default router;

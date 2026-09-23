/**
 * Spend controls for the paid parts of VoiceRx.
 *
 * THE THREAT MODEL IS NOT A MALICIOUS DOCTOR
 * It is one clinic — through a bug, a stuck retry loop, or simple enthusiasm —
 * exhausting a shared ASR quota and taking voice down for every other clinic.
 * Groq's free tier is 20 requests/minute and 2,000/day for the whole
 * organisation, so a single runaway caller is all it takes.
 *
 * FOUR LAYERS, CHEAPEST FIRST
 *   1. per-doctor burst limit   — nobody dictates 10 times a minute
 *   2. per-branch daily quota   — the clinic's share of the day
 *   3. audio duration ceiling   — billing is per second, so this IS the cost cap
 *   4. usage attribution        — you cannot spot abuse you cannot see
 *
 * EVERY LIMIT DEGRADES, NONE BLOCKS THE CONSULTATION
 * Past a quota the microphone disappears and the typed editor stays exactly as
 * it was. A doctor must never be unable to prescribe because an API budget ran
 * out — voice is an accelerator, and an accelerator that can halt the car is a
 * defect, not a safety feature.
 */
import { createRateLimiter, incrementRateLimitKey } from '../../middleware/rateLimit';
import type { AuthRequest } from '../../middleware/auth';
import { logger } from '../../lib/logger';

/** Audio longer than this is not a prescription; it is a stuck recorder. */
export const MAX_AUDIO_SECONDS = Number(process.env.VOICE_RX_MAX_AUDIO_SECONDS || 180);
/** 25MB matches multer and sits under both providers' limits. */
export const MAX_AUDIO_BYTES = Number(process.env.VOICE_RX_MAX_AUDIO_BYTES || 25 * 1024 * 1024);
/** A clinic's share of the day. Tune per plan. */
export const DAILY_BRANCH_LIMIT = Number(process.env.VOICE_RX_DAILY_BRANCH_LIMIT || 400);

/**
 * Burst limit, per doctor.
 *
 * A doctor dictating a prescription does so once or twice per consultation. Six
 * in a minute is already generous and well under Groq's 20/min org-wide cap, so
 * one enthusiastic user cannot starve their colleagues.
 */
export const transcribeBurstLimit = createRateLimiter({
  namespace: 'voicerx-burst',
  windowMs: 60_000,
  maxRequests: Number(process.env.VOICE_RX_BURST_PER_MIN || 6),
  // Keyed on the DOCTOR, not the IP: a clinic behind one NAT would otherwise
  // throttle its own staff collectively.
  keyGenerator: (req) => {
    const r = req as AuthRequest;
    return [r.user?.id ?? r.ip ?? 'unknown'];
  },
  onLimit: (_req, res, retryAfter) => {
    res.status(429).json({
      error: 'VOICE_RATE_LIMITED',
      // Phrased for a doctor mid-consultation, not for a log file.
      message: `Dictation is busy — try again in ${retryAfter}s, or type the prescription.`,
      retryAfter,
    });
  },
});

/** Midnight IST, so a clinic's day matches the clinic's day. */
function istDayKey(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

export interface QuotaState { used: number; limit: number; remaining: number; exceeded: boolean }

/**
 * Count one transcription against the branch's day.
 *
 * Uses the same Redis-backed counter as every other limit here. If Redis is
 * unavailable the call is ALLOWED — a spend control that takes the feature down
 * when the cache blinks is worse than the overspend it prevents.
 */
export async function consumeBranchQuota(branchId: string): Promise<QuotaState> {
  const limit = DAILY_BRANCH_LIMIT;
  try {
    const state = await incrementRateLimitKey(`voicerx-day:${branchId}:${istDayKey()}`, 26 * 3600 * 1000);
    const used = state.count;
    return { used, limit, remaining: Math.max(0, limit - used), exceeded: used > limit };
  } catch (err) {
    logger.error({ err, branchId }, 'voiceRx: quota check failed, allowing');
    return { used: 0, limit, remaining: limit, exceeded: false };
  }
}

export interface AudioCheck { ok: boolean; reason?: string }

/**
 * Reject audio that cannot be a prescription.
 *
 * Duration is the real cost control — both providers bill per second — but it is
 * only known after decoding, so size is the cheap pre-filter. A generous bitrate
 * estimate keeps this from rejecting a legitimate high-quality clip.
 */
export function checkAudio(bytes: number, mimetype?: string): AudioCheck {
  if (bytes <= 0) return { ok: false, reason: 'Empty audio' };
  if (bytes > MAX_AUDIO_BYTES) {
    return { ok: false, reason: `Recording is too large (${Math.round(bytes / 1024 / 1024)}MB, limit ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)}MB)` };
  }
  if (mimetype && !/^(audio|video)\//.test(mimetype) && mimetype !== 'application/octet-stream') {
    return { ok: false, reason: `Not an audio file (${mimetype})` };
  }
  return { ok: true };
}

/** Post-decode duration gate, once the provider tells us how long it was. */
export function checkDuration(seconds: number | null): AudioCheck {
  if (seconds == null) return { ok: true };
  if (seconds > MAX_AUDIO_SECONDS) {
    return { ok: false, reason: `Recording is ${Math.round(seconds)}s, limit ${MAX_AUDIO_SECONDS}s. Dictate one prescription at a time.` };
  }
  return { ok: true };
}

/**
 * One line per paid call, so spend is attributable.
 *
 * Deliberately NOT the audit log: this is operational telemetry about cost, not
 * a clinical record, and AuditLog is insert-only and precious. It is also what
 * tells you which clinic to talk to before a quota becomes a surprise.
 */
export function recordUsage(input: {
  branchId: string; userId: string; provider: string; model: string;
  durationSec: number | null; extractionModel?: string | null; quota: QuotaState;
}): void {
  logger.info(
    {
      voicerxUsage: true,
      branchId: input.branchId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      durationSec: input.durationSec,
      extractionModel: input.extractionModel ?? null,
      quotaUsed: input.quota.used,
      quotaLimit: input.quota.limit,
    },
    'voiceRx: paid call',
  );
}

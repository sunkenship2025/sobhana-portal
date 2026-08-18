/**
 * Patient principal — separate from staff `authMiddleware`.
 *
 * A patient logs in with a WhatsApp OTP and gets a `pjwt` httpOnly cookie signed
 * with the SAME `JWT_SECRET` but carrying `typ:'patient'` and NO `role` claim.
 * Isolation from staff rests on three things (see docs/patient-portal/BUILD-MAP.md
 * "security seam"): the cookie is named `pjwt` (staff reads `jwt`), this middleware
 * asserts `typ==='patient'`, and the payload has no `role` so a stray pjwt can never
 * satisfy staff `requireRole`.
 *
 * The token carries only the verified phone; the patient list is resolved PER REQUEST
 * (design E) so a relative registered at the counter this morning shows up this
 * afternoon with no re-login, and a merged/removed record vanishes at once.
 *
 * Real logout (F6): each token has a `jti`; logout denylists it in Redis until it
 * would expire. Session length is 24–48h (F6), tunable via PATIENT_SESSION_SEC.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { logger as rootLogger } from '../lib/logger';
import { getSecurityRedisClient } from '../lib/redis';
import { findPatientsByIdentifier } from '../services/patientMatchingService';

const PATIENT_COOKIE = 'pjwt';
const SESSION_SEC = Number(process.env.PATIENT_SESSION_SEC) || 48 * 60 * 60; // 48h default (F6)
const COOKIE_PATH = '/api/patient';
const DENYLIST_KEY = (jti: string) => `patient-logout:v1:${jti}`;

export interface PatientToken {
  typ: 'patient';
  phone: string;
  jti?: string;
  exp?: number;
}

export interface PatientRequest extends Request {
  /** Set by patientAuthMiddleware after pjwt verification. */
  patient?: { phone: string; jti?: string; exp?: number };
  /** All patient ids linked to the verified number, resolved per request. */
  patientIds?: string[];
}

/** Sign a patient session token. No `role` claim — that's the staff-crossover guard. */
export function signPatientToken(phone10: string): string {
  return jwt.sign({ typ: 'patient', phone: phone10 }, process.env.JWT_SECRET!, {
    expiresIn: SESSION_SEC,
    jwtid: crypto.randomUUID(),
  });
}

export function setPatientCookie(res: Response, token: string): void {
  res.cookie(PATIENT_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', // same-site (portal. + api. share the registrable domain) → durable
    maxAge: SESSION_SEC * 1000,
    path: COOKIE_PATH,
  });
}

export function clearPatientCookie(res: Response): void {
  res.clearCookie(PATIENT_COOKIE, { path: COOKIE_PATH });
}

/** F6 real logout: denylist a token's jti until it would have expired anyway. */
export async function revokePatientToken(jti?: string, exp?: number): Promise<void> {
  const client = getSecurityRedisClient();
  if (!client || !jti) return;
  const ttl = exp ? Math.max(1, exp - Math.floor(Date.now() / 1000)) : SESSION_SEC;
  try {
    await client.set(DENYLIST_KEY(jti), '1', 'EX', ttl);
  } catch {
    /* best-effort — logout still clears the cookie client-side */
  }
}

async function isRevoked(jti?: string): Promise<boolean> {
  const client = getSecurityRedisClient();
  if (!client || !jti) return false;
  try {
    return (await client.exists(DENYLIST_KEY(jti))) === 1;
  } catch {
    return false; // fail open — availability over a best-effort denylist
  }
}

/**
 * Gate for every patient route. 401 (uniform) on any failure.
 * Attaches `req.patient` and `req.patientIds` (resolved live from the number).
 */
export async function patientAuthMiddleware(
  req: PatientRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const unauth = () => {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Please sign in again.' });
  };
  try {
    const token: string | undefined = (req as any).cookies?.[PATIENT_COOKIE];
    if (!token) return unauth();

    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as PatientToken;
    if (decoded.typ !== 'patient' || !decoded.phone) return unauth();
    if (await isRevoked(decoded.jti)) return unauth();

    // Per-request family resolution (design E). Phone in the token is always a
    // normalised 10-digit string, so the exact-match finder is safe.
    const matches = await findPatientsByIdentifier(
      { phone: decoded.phone },
      { includeVisitHistory: false },
    );

    req.patient = { phone: decoded.phone, jti: decoded.jti, exp: decoded.exp };
    req.patientIds = matches.map((m) => m.patient.id);
    next();
  } catch (err: any) {
    const log = (req as any).log || rootLogger;
    log.warn({ err: err?.name }, 'patient-auth rejected');
    unauth();
  }
}

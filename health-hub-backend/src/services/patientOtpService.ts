/**
 * Patient-portal OTP.
 *
 * Phone-normalise → generate a 6-digit code → store HASHED in Redis (5-min TTL) →
 * send over WhatsApp via the existing `sendTemplate`. Verify is timing-safe and
 * consumes the code. Non-oracle: `requestOtp` only sends to real patients but the
 * route always 204s, so login can't probe who is a patient.
 *
 * No new tables and no MessageLog write (which would need a `MessageContextType`
 * enum migration) — auth events are logged via the app logger (phone tail only,
 * never the code). Brute-force is handled at the route by reusing loginLockout
 * with a `patient-otp:<phone>` key. See docs/patient-portal/BUILD-MAP.md.
 */

import crypto from 'crypto';
import { getSecurityRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';
import {
  sendTemplate,
  isWhatsAppEnabled,
  formatPhoneForWhatsApp,
  type TemplateComponent,
} from './whatsappCloudService';
import { findPatientsByIdentifier } from './patientMatchingService';

const OTP_TTL_SEC = 5 * 60;
const OTP_KEY = (phone: string) => `patient-otp:v1:${phone}`;
// The approved Meta AUTHENTICATION template name (owner submits it; OWNER-TASKS A).
const OTP_TEMPLATE = process.env.PATIENT_OTP_TEMPLATE || 'patient_login_otp';
// Secret pepper so a Redis dump alone can't be used to verify guessed codes.
const pepper = () => process.env.OTP_PEPPER || process.env.JWT_SECRET || 'dev-otp-pepper-change-me';

/**
 * Normalise any Indian phone input to a bare 10-digit string, or `null` if it
 * isn't a valid Indian mobile. `findPatientsByIdentifier` requires exactly 10
 * digits, and identifiers are stored in that form.
 */
export function normalizePhone(input: string): string | null {
  const digits = (input || '').replace(/\D/g, '');
  let ten = digits;
  if (ten.length === 12 && ten.startsWith('91')) ten = ten.slice(2);
  else if (ten.length === 11 && ten.startsWith('0')) ten = ten.slice(1);
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

function hashCode(phone: string, code: string): string {
  return crypto.createHmac('sha256', pepper()).update(`${phone}:${code}`).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Meta AUTHENTICATION-template components: body copy + copy-code URL button, both carry the code. */
function otpComponents(code: string): TemplateComponent[] {
  return [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
    { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] },
  ];
}

/**
 * Issue an OTP — ONLY if `phone10` belongs to a patient. Never reveals whether it
 * did (the route 204s regardless). Safe to call with any normalised number.
 */
export async function requestOtp(phone10: string): Promise<void> {
  const client = getSecurityRedisClient();
  if (!client) {
    logger.warn('patient-otp: no Redis client, cannot issue OTP');
    return;
  }

  // Non-oracle gate: send only to real patients.
  let isPatient = false;
  try {
    const matches = await findPatientsByIdentifier(
      { phone: phone10 },
      { includeVisitHistory: false, limit: 1 },
    );
    isPatient = matches.length > 0;
  } catch (err) {
    logger.warn({ err }, 'patient-otp: patient lookup failed');
    return;
  }
  if (!isPatient) return;

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    await client.set(OTP_KEY(phone10), hashCode(phone10, code), 'EX', OTP_TTL_SEC);
  } catch (err) {
    logger.error({ err }, 'patient-otp: failed to store code');
    return;
  }

  if (!isWhatsAppEnabled()) {
    logger.warn({ phoneTail: phone10.slice(-4) }, 'patient-otp: WhatsApp disabled — code stored but not sent');
    return;
  }
  try {
    await sendTemplate(formatPhoneForWhatsApp(phone10), OTP_TEMPLATE, otpComponents(code));
    logger.info({ phoneTail: phone10.slice(-4) }, 'patient-otp: sent'); // audit (F15) — never the code
  } catch (err) {
    logger.error({ err, phoneTail: phone10.slice(-4) }, 'patient-otp: WhatsApp send failed');
  }
}

export type VerifyResult = 'ok' | 'wrong' | 'none';

/**
 * Verify a 6-digit code, timing-safe. Consumes the code on success.
 *   'ok'    — matched (and consumed)
 *   'wrong' — a real guess against a PENDING code that didn't match
 *   'none'  — no code pending / malformed / Redis down (NOT a real guess)
 * The caller returns a uniform "invalid code" for both 'wrong' and 'none' (F12,
 * no oracle) but only counts a failed attempt on 'wrong' — so someone spamming
 * verify against a number with no OTP in flight can't drive the lockout (DoS).
 */
export async function verifyOtp(phone10: string, code: string): Promise<VerifyResult> {
  const client = getSecurityRedisClient();
  if (!client) return 'none';
  if (!/^\d{6}$/.test(code || '')) return 'none';

  let stored: string | null = null;
  try {
    stored = await client.get(OTP_KEY(phone10));
  } catch {
    return 'none';
  }
  if (!stored) return 'none';

  if (timingSafeEqualHex(stored, hashCode(phone10, code))) {
    try {
      await client.del(OTP_KEY(phone10));
    } catch {
      /* best-effort consume */
    }
    return 'ok';
  }
  return 'wrong';
}

// --- self-check: `npx ts-node src/services/patientOtpService.ts` (pure logic only, no Redis) ---
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const assert = require('assert');
  // normalizePhone
  assert.equal(normalizePhone('9876543210'), '9876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalizePhone('09876543210'), '9876543210');
  assert.equal(normalizePhone('919876543210'), '9876543210');
  assert.equal(normalizePhone('12345'), null); // too short
  assert.equal(normalizePhone('5876543210'), null); // Indian mobiles start 6-9
  assert.equal(normalizePhone('98765 43210 x'), '9876543210'); // strips junk
  // hash is deterministic + verify is symmetric
  const h = hashCode('9876543210', '123456');
  assert.equal(timingSafeEqualHex(h, hashCode('9876543210', '123456')), true);
  assert.equal(timingSafeEqualHex(h, hashCode('9876543210', '123457')), false);
  assert.equal(timingSafeEqualHex(h, hashCode('9876543211', '123456')), false);
  // components carry the code in both body and copy-code button
  const comps = otpComponents('654321');
  assert.equal(comps[0].parameters[0].text, '654321');
  assert.equal(comps[1].sub_type, 'url');
  assert.equal(comps[1].parameters[0].text, '654321');
  // eslint-disable-next-line no-console
  console.log('patientOtpService self-check: OK');
}

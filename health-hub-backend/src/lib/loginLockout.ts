/**
 * Sustained-window login lockout.
 *
 * Sits ON TOP of the existing per-minute rate limiters in middleware/rateLimit.ts:
 *   - Rate limit (per minute):  caps burst speed (5/min/credential).
 *   - This lockout (rolling 15min): caps total attempts before forcing a cool-down.
 *
 * Without this, an attacker paced at 5 attempts/minute can do ~7,000 guesses/day
 * per email and our rate limit never kicks in.
 *
 * Mechanics:
 *   - Every failed attempt for an email increments a Redis counter with a 15-minute TTL.
 *   - On the 12th failure within that window, set a separate "locked" key (also 15 min).
 *   - While the locked key is present, login is rejected with 423 regardless of password.
 *   - On any successful login, both counter and lock are cleared for that email.
 *   - If Redis is unreachable, all lockout checks fail open (no protection but no false
 *     positives either) — auth still works for legitimate users.
 */

import { getSecurityRedisClient } from './redis';
import { logger } from './logger';

const ATTEMPT_THRESHOLD = 12;            // failed attempts in window before lockout
const ATTEMPT_WINDOW_SEC = 15 * 60;      // 15-minute rolling window
const LOCKOUT_DURATION_SEC = 15 * 60;    // 15-minute lockout when threshold hit

const ATTEMPTS_KEY = (email: string) => `login-attempts:v1:${email.toLowerCase()}`;
const LOCK_KEY = (email: string) => `login-lock:v1:${email.toLowerCase()}`;

export interface LockoutStatus {
  locked: boolean;
  /** Seconds remaining on the lockout. 0 if not locked. */
  retryAfterSec: number;
  /** Failed attempts recorded in the current window. */
  attemptsInWindow: number;
}

/** Check if an email is currently locked out. Fails open if Redis is unavailable. */
export async function checkLockout(email: string): Promise<LockoutStatus> {
  const client = getSecurityRedisClient();
  if (!client) {
    return { locked: false, retryAfterSec: 0, attemptsInWindow: 0 };
  }

  try {
    const [lockTtl, attempts] = await Promise.all([
      client.ttl(LOCK_KEY(email)),
      client.get(ATTEMPTS_KEY(email)),
    ]);
    const attemptsInWindow = Number(attempts) || 0;
    if (lockTtl > 0) {
      return { locked: true, retryAfterSec: lockTtl, attemptsInWindow };
    }
    return { locked: false, retryAfterSec: 0, attemptsInWindow };
  } catch (err: any) {
    logger.warn({ err, email }, 'login lockout: read failed (failing open)');
    return { locked: false, retryAfterSec: 0, attemptsInWindow: 0 };
  }
}

/**
 * Record a failed attempt. Returns the resulting status; if `locked` is true,
 * the email was just locked out by this attempt and the caller should reject
 * the login with that retryAfter.
 */
export async function recordFailedAttempt(email: string): Promise<LockoutStatus> {
  const client = getSecurityRedisClient();
  if (!client) {
    return { locked: false, retryAfterSec: 0, attemptsInWindow: 0 };
  }

  try {
    const key = ATTEMPTS_KEY(email);
    const count = await client.incr(key);
    // Reset TTL on every increment so the window is rolling — 5 attempts spread
    // over 14 minutes still trigger lockout.
    await client.expire(key, ATTEMPT_WINDOW_SEC);

    if (count >= ATTEMPT_THRESHOLD) {
      await client.set(LOCK_KEY(email), '1', 'EX', LOCKOUT_DURATION_SEC);
      logger.warn(
        { email, attempts: count, lockoutSec: LOCKOUT_DURATION_SEC },
        'login lockout: threshold hit, account locked',
      );
      return { locked: true, retryAfterSec: LOCKOUT_DURATION_SEC, attemptsInWindow: count };
    }
    return { locked: false, retryAfterSec: 0, attemptsInWindow: count };
  } catch (err: any) {
    logger.warn({ err, email }, 'login lockout: record failed (failing open)');
    return { locked: false, retryAfterSec: 0, attemptsInWindow: 0 };
  }
}

/** Clear attempt counter and lock on successful login. */
export async function clearAttempts(email: string): Promise<void> {
  const client = getSecurityRedisClient();
  if (!client) return;
  try {
    await Promise.all([client.del(ATTEMPTS_KEY(email)), client.del(LOCK_KEY(email))]);
  } catch (err: any) {
    logger.warn({ err, email }, 'login lockout: clear failed');
  }
}

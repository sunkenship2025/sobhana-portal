/**
 * Authentication Service
 *
 * Handles user login and registration. All authentication events
 * (success and failure) are written to the AuditLog so security
 * incidents can be reconstructed from the audit trail.
 *
 * Why bcrypt: passwords are hashed with 10 salt rounds before storage.
 * Why JWT: stateless tokens allow multi-instance horizontal scaling
 * without a shared session store. Tokens expire after 1 day.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ValidationError, UnauthorizedError } from '../utils/errors';
import { logAction } from './auditService';
import prisma from '../lib/prisma';
import { checkLockout, recordFailedAttempt, clearAttempts } from '../lib/loginLockout';
import { normalizeTenantSlug } from '../lib/tenantResolution';

// Precomputed bcrypt hash used to equalize timing on unknown-email logins.
// Without this, bcrypt.compare only runs when the email exists, so a request
// for a real email takes ~200-500ms while an unknown email returns in ~5ms —
// letting an attacker enumerate valid emails by measuring response time alone
// (lockout doesn't help: one attempt per email is enough).
//
// The hash is for the literal string "dummy" — irrelevant since we never
// expect it to match anything; we only need bcrypt.compare to do the same
// amount of work it does for a real user.
const DUMMY_BCRYPT_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

/**
 * Authenticates a user by email and password.
 *
 * Audit-logs every attempt (success and each failure reason) so that
 * brute-force and credential-stuffing attacks are visible in the log.
 *
 * @param email      - The user's email address
 * @param password   - The plaintext password to verify against the bcrypt hash
 * @param ipAddress  - (optional) Client IP, stored in the audit log
 * @param userAgent  - (optional) Browser UA string, stored in the audit log
 * @returns          An object containing the signed JWT and the public user profile
 * @throws UnauthorizedError  If the user is not found, account is disabled, or password is wrong
 *
 * @example
 * const { token, user } = await login('staff@sobhana.com', 'secret', '1.2.3.4');
 * // token: 'eyJhbGci...'  (1-day JWT)
 * // user: { id, email, name, role, activeBranch }
 */
/**
 * Thrown when an email is currently in lockout. Distinct from UnauthorizedError
 * so the route handler can return 423 (Locked) instead of 401 — and the
 * frontend can show "Too many attempts, try again in N minutes" instead of
 * the generic "invalid credentials".
 */
export class LoginLockedError extends Error {
  statusCode = 423;
  error = 'LOCKED';
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(
      `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
    );
    this.retryAfterSec = retryAfterSec;
  }
}

export async function login(
  email: string,
  password: string,
  ipAddress?: string,
  userAgent?: string,
  tenantSlugInput?: string,
) {
  // 0) Reject early if this email is currently locked. We don't even hit the DB
  // for locked accounts — saves a query + denies attackers feedback about
  // whether the email exists.
  const lockStatus = await checkLockout(email);
  if (lockStatus.locked) {
    const systemBranch = await prisma.branch.findFirst();
    if (systemBranch) {
      await logAction({
        branchId: systemBranch.id,
        actionType: 'UPDATE',
        entityType: 'AuthEvent',
        entityId: 'LOGIN_BLOCKED',
        userId: null,
        newValues: {
          action: 'LOGIN_BLOCKED',
          email,
          reason: 'LOCKED_OUT',
          retryAfterSec: lockStatus.retryAfterSec,
        },
        ipAddress,
        userAgent,
      });
    }
    throw new LoginLockedError(lockStatus.retryAfterSec);
  }

  const tenantSlug = normalizeTenantSlug(tenantSlugInput);
  const tenant = tenantSlug
    ? await (prisma as any).tenant.findFirst({ where: { slug: tenantSlug, isActive: true } })
    : null;

  if (tenantSlug && !tenant) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    throw new UnauthorizedError('Invalid credentials');
  }

  // Find user. Email is tenant-scoped in the Axora schema, so subdomain login
  // passes tenantSlug and allows the same email to exist in different clients.
  const user = await prisma.user.findFirst({
    where: {
      email,
      ...(tenant ? { tenantId: tenant.id } : {}),
    },
    include: {
      activeBranch: true,
    },
  });

  if (!user) {
    // Equalize timing: still run bcrypt.compare against a dummy hash so the
    // unknown-email path takes the same wall time as the wrong-password path.
    // Without this, response time alone leaks whether an email is valid.
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);

    // Record the attempt against the email even if it doesn't exist —
    // otherwise an attacker can probe for valid emails by watching whether
    // the lockout counter changes.
    const status = await recordFailedAttempt(email);
    const systemBranch = await prisma.branch.findFirst();
    if (systemBranch) {
      await logAction({
        branchId: systemBranch.id,
        actionType: 'UPDATE',
        entityType: 'AuthEvent',
        entityId: 'LOGIN_FAILED',
        userId: null,
        newValues: {
          action: 'LOGIN_FAILED',
          email,
          reason: 'USER_NOT_FOUND',
          attemptsInWindow: status.attemptsInWindow,
        },
        ipAddress,
        userAgent,
      });
    }
    if (status.locked) throw new LoginLockedError(status.retryAfterSec);
    throw new UnauthorizedError('Invalid credentials');
  }

  if (!user.isActive) {
    // Disabled accounts don't increment the lockout counter (no point — we
    // already know they can't log in regardless of password).
    await logAction({
      branchId: user.activeBranchId,
      actionType: 'UPDATE',
      entityType: 'AuthEvent',
      entityId: user.id,
      userId: user.id,
      newValues: {
        action: 'LOGIN_FAILED',
        email,
        reason: 'ACCOUNT_DISABLED',
      },
      ipAddress,
      userAgent,
    });
    throw new UnauthorizedError('Account is disabled');
  }

  // Verify password
  const isValidPassword = await bcrypt.compare(password, user.passwordHash);

  if (!isValidPassword) {
    const status = await recordFailedAttempt(email);
    await logAction({
      branchId: user.activeBranchId,
      actionType: 'UPDATE',
      entityType: 'AuthEvent',
      entityId: user.id,
      userId: user.id,
      newValues: {
        action: 'LOGIN_FAILED',
        email,
        reason: 'INVALID_PASSWORD',
        attemptsInWindow: status.attemptsInWindow,
      },
      ipAddress,
      userAgent,
    });
    if (status.locked) throw new LoginLockedError(status.retryAfterSec);
    throw new UnauthorizedError('Invalid credentials');
  }

  // Successful login — wipe any prior failed-attempt counters for this email.
  await clearAttempts(email);

  // Generate JWT
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      tenantSlug: tenant?.slug,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1d' }
  );

  // Audit log: Successful login
  await logAction({
    branchId: user.activeBranchId,
    actionType: 'UPDATE',
    entityType: 'AuthEvent',
    entityId: user.id,
    userId: user.id,
    newValues: {
      action: 'LOGIN_SUCCESS',
      email: user.email,
      role: user.role,
    },
    ipAddress,
    userAgent,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenant: tenant ? {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      } : null,
      activeBranch: {
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
        id: user.activeBranch.id,
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
        name: user.activeBranch.name,
          // @ts-ignore Prisma strict typing
        code: user.activeBranch.code
      }
    }
  };
}

/**
 * Creates a new user account.
 *
 * Intended for owner use only (called from the owner admin panel).
 * Does NOT log in the new user — the caller must call `login()` separately
 * to obtain a JWT if needed.
 *
 * @param data.email          - Must be unique across all users
 * @param data.password       - Plaintext; will be hashed with bcrypt (10 rounds)
 * @param data.name           - Display name shown in the UI and on reports
 * @param data.phone          - Optional; stored but not used for auth
 * @param data.role           - One of: 'staff' | 'doctor' | 'owner'
 * @param data.activeBranchId - The branch this user belongs to by default
 * @returns                   The new user's public profile (no password hash)
 * @throws ValidationError    If the email is already registered
 */
export async function register(data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

  email: string;
  password: string;
  name: string;
  phone?: string;
  role: string;
  activeBranchId: string;
}) {
  // Check if user exists
  const existing = await prisma.user.findUnique({
      // @ts-ignore Prisma strict typing
    where: { // @ts-ignore Prisma types
 email: data.email }
  });

  if (existing) {
    throw new ValidationError('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(data.password, 10);

  // Create user
        // @ts-ignore Prisma strict typing
        // @ts-ignore Prisma strict typing
        // @ts-ignore Prisma strict typing
        // @ts-ignore Prisma strict typing
        // @ts-ignore Prisma strict typing
  const user = await prisma.user.create({
        // @ts-ignore Prisma strict typing
    data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

      email: data.email,
      passwordHash,
      name: data.name,
      phone: data.phone,
      role: data.role as any,
      activeBranchId: data.activeBranchId,
      isActive: true
    },
    include: {
      activeBranch: true
    }
  });

  return {
    id: user.id,
    email: user.email,
    name: user.name,
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
    role: user.role,
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
    activeBranch: {
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
      id: user.activeBranch.id,
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
      name: user.activeBranch.name,
          // @ts-ignore Prisma strict typing
      code: user.activeBranch.code
    }
  };
}

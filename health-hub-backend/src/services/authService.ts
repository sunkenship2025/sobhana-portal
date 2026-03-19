/**
 * Authentication Service
 *
 * Handles user login and registration. All authentication events
 * (success and failure) are written to the AuditLog so security
 * incidents can be reconstructed from the audit trail.
 *
 * Why bcrypt: passwords are hashed with 10 salt rounds before storage.
 * Why JWT: stateless tokens allow multi-instance horizontal scaling
 * without a shared session store. Tokens expire after 7 days.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { ValidationError, UnauthorizedError } from '../utils/errors';
import { logAction } from './auditService';
import prisma from '../lib/prisma';

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
 * // token: 'eyJhbGci...'  (7-day JWT)
 * // user: { id, email, name, role, activeBranch }
 */
export async function login(email: string, password: string, ipAddress?: string, userAgent?: string) {
  // Find user
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      activeBranch: true
    }
  });

  if (!user) {
    // Audit log: Failed login attempt
    // Use a system branch ID for failed auth events (get first branch as fallback)
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
        },
        ipAddress,
        userAgent,
      });
    }
    throw new UnauthorizedError('Invalid credentials');
  }

  if (!user.isActive) {
    // Audit log: Failed login (account disabled)
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
    // Audit log: Failed login (wrong password)
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
      },
      ipAddress,
      userAgent,
    });
    throw new UnauthorizedError('Invalid credentials');
  }

  // Generate JWT
  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET!,
    { expiresIn: '7d' }
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
      activeBranch: {
        id: user.activeBranch.id,
        name: user.activeBranch.name,
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
export async function register(data: {
  email: string;
  password: string;
  name: string;
  phone?: string;
  role: string;
  activeBranchId: string;
}) {
  // Check if user exists
  const existing = await prisma.user.findUnique({
    where: { email: data.email }
  });

  if (existing) {
    throw new ValidationError('Email already registered');
  }

  // Hash password
  const passwordHash = await bcrypt.hash(data.password, 10);

  // Create user
  const user = await prisma.user.create({
    data: {
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
    role: user.role,
    activeBranch: {
      id: user.activeBranch.id,
      name: user.activeBranch.name,
      code: user.activeBranch.code
    }
  };
}

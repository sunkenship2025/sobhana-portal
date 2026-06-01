/**
 * JWT Authentication Middleware
 *
 * Verifies the `Authorization: Bearer <token>` header on every
 * protected request. On success, attaches decoded token data to
 * `req.user` so downstream route handlers and services can identify
 * the caller without re-querying the database.
 *
 * This middleware is mounted globally in `index.ts` but skipped on:
 *   - POST /api/auth/login  (public)
 *   - GET  /reports/:token  (public, token-based)
 *   - POST /webhooks/whatsapp  (Meta signature verification instead)
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger as rootLogger } from '../lib/logger';

/**
 * The decoded payload of a Sobhana Health Hub JWT.
 * This shape is defined when signing in `authService.login()`.
 */
export interface AuthUser {
  /** The User.id (UUID) from the database */
  id: string;
  email: string;
  /** One of: 'staff' | 'doctor' | 'owner' */
  role: string;
  tenantId?: string;
  tenantSlug?: string;
}

/**
 * Extends Express's Request type to carry auth and branch context
 * injected by the auth and branch middleware.
 */
export interface AuthRequest extends Request {
  /** Set by `authMiddleware` after JWT verification */
  user?: AuthUser;
  /** Set by `branchContextMiddleware` from X-Branch-Id header or user.activeBranchId */
  branchId?: string;
}

/**
 * Express middleware that verifies the JWT and attaches `req.user`.
 *
 * Token resolution order:
 *   1. `req.cookies.jwt` — set by the login route as an httpOnly cookie. This
 *      is the preferred source: the token is not exposed to JavaScript on the
 *      frontend, so XSS cannot exfiltrate it.
 *   2. `Authorization: Bearer <token>` — kept for backward compatibility with
 *      callers that still attach the token from in-memory authStore state.
 *
 * Returns 401 if neither source provides a valid token.
 * Returns 500 for unexpected errors (e.g. JWT_SECRET misconfiguration).
 */
export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Prefer the httpOnly cookie (XSS-safe) over the Authorization header.
    let token: string | undefined = (req as any).cookies?.jwt;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'No token provided'
      });
      return;
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;

    // Attach user to request
    req.user = decoded;
    next();
  } catch (err: any) {
    // Use req.log if pino-http has attached it; fall back to root logger.
    const log = (req as any).log || rootLogger;
    if (err.name === 'JsonWebTokenError') {
      log.warn({ ip: req.ip }, 'auth rejected: invalid JWT');
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid token' });
    } else if (err.name === 'TokenExpiredError') {
      log.info({ ip: req.ip }, 'auth rejected: expired JWT');
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token expired' });
    } else {
      log.error({ err, ip: req.ip }, 'auth middleware crashed');
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Authentication failed' });
    }
  }
};

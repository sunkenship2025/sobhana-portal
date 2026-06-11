import { Router, Response } from 'express';
import * as authService from '../services/authService';
import prisma from '../lib/prisma';
import { requireRole } from '../middleware/rbac';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loginCredentialRateLimit, loginIpRateLimit } from '../middleware/rateLimit';

const router = Router();

// JWT cookie configuration. httpOnly keeps the token out of JS so an XSS
// payload can't read it. SameSite=lax allows top-level navigation (so
// patients clicking a /reports/:token link arrive properly) while still
// preventing CSRF on cross-site form posts.
//
// MaxAge MUST match the JWT `expiresIn` set in authService.login() — otherwise
// the cookie sits in the browser past JWT expiry, every authMiddleware run
// returns 401, and the user gets bounced to /login mid-session.
const JWT_COOKIE_NAME = 'jwt';
const JWT_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day — matches JWT expiresIn '1d'

function setJwtCookie(res: Response, token: string) {
  res.cookie(JWT_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: JWT_COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearJwtCookie(res: Response) {
  res.clearCookie(JWT_COOKIE_NAME, { path: '/' });
}

// POST /api/auth/login - Public
router.post('/login', loginIpRateLimit, loginCredentialRateLimit, async (req, res) => {
  try {
    const { email, password, tenantSlug } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email and password are required'
      });
    }

    const result = await authService.login(email, password, req.ip, req.get('user-agent'), tenantSlug);

    // Set the JWT in an httpOnly cookie. We also still return the token in the
    // response body so existing in-memory state on the frontend continues to
    // work without changes to the ~150 inline fetches that send Authorization
    // headers. The cookie is the persistent layer (survives refresh); the
    // returned token is what the frontend uses for the current session's
    // Authorization headers, kept in memory only (not localStorage).
    setJwtCookie(res, result.token);

    return res.json(result);
  } catch (err: any) {
    if (err.statusCode === 423 && typeof err.retryAfterSec === 'number') {
      // Lockout: tell the client when to retry. Some clients respect Retry-After.
      res.setHeader('Retry-After', String(err.retryAfterSec));
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message,
        ...(typeof err.retryAfterSec === 'number' ? { retryAfterSec: err.retryAfterSec } : {}),
      });
    } else {
      (req as any).log?.error?.({ err }, 'login crashed') ?? console.error('Login error:', err);
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Login failed'
      });
    }
  }
});

// GET /api/auth/me - Hydrate session after page refresh.
// The browser sent the httpOnly cookie automatically; authMiddleware verified
// it and attached req.user. We reload the User row to fetch the fields the
// JWT doesn't carry (name, activeBranch) and return the same shape as login,
// so the frontend can re-populate authStore without forcing a re-login.
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'No active session' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: { activeBranch: true },
    });

    if (!user || !user.isActive) {
      // The JWT was valid but the user is gone or deactivated. Clear the
      // cookie so the next request doesn't keep failing.
      clearJwtCookie(res);
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Account not found or disabled' });
    }

    // Resolve the token to hand back. authMiddleware already verified it from
    // either source; we just need to find which one for the response body.
    // Header-only callers (privacy-mode browsers, clients with cookies stripped)
    // get a fresh cookie set so the next request can use it; their existing
    // header-based call already authenticated them.
    const cookieToken = (req as any).cookies?.jwt as string | undefined;
    const headerAuth = req.headers.authorization;
    const headerToken = headerAuth?.startsWith('Bearer ')
      ? headerAuth.split(' ')[1]
      : undefined;
    const token = cookieToken || headerToken;
    if (!token) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'No session token' });
    }
    if (!cookieToken && headerToken) {
      // Re-issue the cookie so the client can stop relying on the header on
      // subsequent requests (header path is the legacy compat hatch).
      setJwtCookie(res, headerToken);
    }

    const tenant = await (prisma as any).tenant.findUnique({
      where: { id: user.tenantId },
      select: { id: true, slug: true, name: true },
    });

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenant,
        activeBranch: {
          id: user.activeBranch.id,
          name: user.activeBranch.name,
          code: user.activeBranch.code,
        },
      },
    });
  } catch (err: any) {
    (req as any).log?.error?.({ err }, '/me crashed') ?? console.error('/me error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load session' });
  }
});

// POST /api/auth/logout - Clear the JWT cookie.
// We don't blacklist the JWT server-side (no infrastructure for that today),
// so the token remains valid until expiry. This route's job is to clean up
// the persistent state on the client; in-memory state is the frontend's job.
router.post('/logout', (_req, res) => {
  clearJwtCookie(res);
  return res.status(204).end();
});

// POST /api/auth/register - Admin only
router.post('/register', authMiddleware, requireRole('admin'), async (req: AuthRequest, res) => {
  try {
    const { email, password, name, phone, role, activeBranchId } = req.body;

    if (!email || !password || !name || !role || !activeBranchId) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Email, password, name, role, and activeBranchId are required'
      });
    }

    const user = await authService.register({
      email,
      password,
      name,
      phone,
      role,
      activeBranchId
    });

    return res.status(201).json(user);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    } else {
      console.error('Register error:', err);
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Registration failed'
      });
    }
  }
});

export default router;

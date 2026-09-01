/**
 * Branch Context Middleware
 *
 * Resolves and attaches `req.branchId` to every authenticated request.
 *
 * Priority order:
 *   1. `X-Branch-Id` request header — allows staff to operate on a specific
 *      branch (used when the user has access to multiple branches, e.g. owner).
 *   2. `user.activeBranchId` from the database — the user's default branch.
 *
 * This middleware also verifies that:
 *   - The user account is still active (not disabled between requests)
 *   - The requested branch exists and is active
 *
 * All downstream services rely on `req.branchId` being set correctly.
 * Any Prisma query that should be branch-scoped MUST include
 * `branchId: req.branchId` in its `where` clause.
 */
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';

/**
 * The two lookups below ran on EVERY authenticated request — 12,036 Postgres
 * round trips a day, measured in production — purely to re-answer "is this
 * account still active, what is its role, is this branch live". Cached for 60s.
 *
 * This is an authorization re-check, so the trade is explicit: the JWT already
 * carries identity, and these reads exist to make revocation immediate. Cached,
 * a disabled account or demoted role stays live for up to the TTL. Two things
 * bound that:
 *
 *  1. INVARIANT: every write to User must call invalidateAuthUser(). Today that
 *     is exactly two sites (role + isActive in routes/users.ts) — there is no
 *     other User mutation in the backend, and activeBranchId is set once at
 *     creation and never updated. ADD THE CALL if you add a third.
 *  2. The TTL is the only guard for changes the app cannot see: a direct SQL
 *     edit, or a prisma/*.ts script (create-staff-users.ts and friends). It is
 *     also the only guard for Branch, which has NO write path in the backend at
 *     all — branches are created and toggled outside the app.
 *
 * Lives in the general (LRU) Redis, not the security store: an evicted entry
 * degrades to a Postgres read, i.e. it fails SAFE. That is the opposite of a
 * lockout counter, where eviction silently hands out fresh guesses.
 */
const USER_KEY = (id: string) => `auth:user:v1:${id}`;
const BRANCH_KEY = (id: string) => `auth:branch:v1:${id}`;
const TTL_SECONDS = 60;

function loadUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, activeBranchId: true, isActive: true },
  });
}

function loadBranch(branchId: string) {
  return prisma.branch.findUnique({
    where: { id: branchId },
    select: { id: true, isActive: true },
  });
}

/**
 * Read through Redis, falling back to Postgres on any cache trouble — a cache
 * outage must never weaken or skip the check, only make it cost a query again.
 *
 * Deliberately silent on failure: lib/redis.ts already logs a client error once
 * per outage, and logging here would emit a line per request on the hot path.
 */
async function cachedLookup<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return load();

  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    return load();
  }

  const value = await load();
  // A miss is NOT cached: a missing user/branch is an anomaly, and caching the
  // absence would keep denying a just-created account for the whole TTL.
  if (value === null) return null;

  try {
    await redis.set(key, JSON.stringify(value), 'EX', TTL_SECONDS);
  } catch {
    // Cached or not, the caller already has a correct answer.
  }
  return value;
}

/**
 * Drop a user's cached authorization row so a role or isActive change takes
 * effect on the very next request instead of at TTL expiry. Best-effort: if
 * Redis is unreachable the TTL still bounds the staleness.
 */
export async function invalidateAuthUser(userId: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(USER_KEY(userId));
  } catch {
    // TTL still bounds it.
  }
}

/**
 * Resolves the active branch for the current request.
 *
 * Must run AFTER `authMiddleware` (requires `req.user` to be set).
 * Sets `req.branchId` on success.
 *
 * @returns 401 if no authenticated user
 * @returns 403 if user account is disabled
 * @returns 400 if the requested branch is missing or inactive
 */
export const branchContextMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User not authenticated'
      });
      return;
    }

    // Fetch user with active branch
    const user = await cachedLookup(USER_KEY(req.user.id), () => loadUser(req.user!.id));

    if (!user) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'User not found'
      });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'User account is disabled'
      });
      return;
    }

    // Inject branch context
    // Priority: x-branch-id header (for branch switching) > user.activeBranchId (default)
    const requestedBranchId = req.headers['x-branch-id'] as string;
    
    if (requestedBranchId) {
      // Verify the requested branch exists
      const branch = await cachedLookup(BRANCH_KEY(requestedBranchId), () =>
        loadBranch(requestedBranchId),
      );

      if (!branch || !branch.isActive) {
        res.status(400).json({
          error: 'INVALID_BRANCH',
          message: 'Requested branch not found or inactive'
        });
        return;
      }

      req.branchId = requestedBranchId;
    } else {
      req.branchId = user.activeBranchId;
    }
    
    req.user.role = user.role;

    next();
  } catch (err: any) {
    console.error('Branch context middleware error:', err);
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load branch context'
    });
  }
};

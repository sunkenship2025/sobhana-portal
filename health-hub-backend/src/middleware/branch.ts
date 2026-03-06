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
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        activeBranchId: true,
        isActive: true
      }
    });

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
      const branch = await prisma.branch.findUnique({
        where: { id: requestedBranchId },
        select: { id: true, isActive: true }
      });

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

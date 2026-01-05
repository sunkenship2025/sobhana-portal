import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth';

const prisma = new PrismaClient();

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
    req.branchId = user.activeBranchId;
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

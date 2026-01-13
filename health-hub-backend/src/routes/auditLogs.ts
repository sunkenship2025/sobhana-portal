import { Router } from 'express';
import { PrismaClient, AuditActionType } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';

const router = Router();
const prisma = new PrismaClient();

// All routes require authentication and branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ===========================================================================
// GET /api/audit-logs - List audit logs for current branch
// Query params: entityType, entityId, actionType, userId, limit, offset
// Access: owner only (sensitive data)
// ===========================================================================
router.get('/', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const {
      entityType,
      entityId,
      actionType,
      userId,
      limit = '50',
      offset = '0',
    } = req.query;

    // Build where clause
    const where: any = { branchId };

    if (entityType) {
      where.entityType = entityType as string;
    }

    if (entityId) {
      where.entityId = entityId as string;
    }

    if (actionType) {
      // Validate actionType
      const validActions: AuditActionType[] = [
        'CREATE',
        'UPDATE',
        'DELETE',
        'FINALIZE',
        'PAYOUT_DERIVE',
        'PAYOUT_PAID',
      ];
      if (!validActions.includes(actionType as AuditActionType)) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `actionType must be one of: ${validActions.join(', ')}`,
        });
      }
      where.actionType = actionType as AuditActionType;
    }

    if (userId) {
      where.userId = userId as string;
    }

    // Parse pagination
    const take = Math.min(parseInt(limit as string, 10) || 50, 100); // Max 100
    const skip = parseInt(offset as string, 10) || 0;

    // Fetch audit logs (most recent first)
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          branchId: true,
          actionType: true,
          entityType: true,
          entityId: true,
          userId: true,
          oldValues: true,
          newValues: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    // Parse JSON strings back to objects for client convenience
    const parsedLogs = logs.map((log) => ({
      ...log,
      oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
      newValues: log.newValues ? JSON.parse(log.newValues) : null,
    }));

    return res.json({
      data: parsedLogs,
      pagination: {
        total,
        limit: take,
        offset: skip,
        hasMore: skip + take < total,
      },
    });
  } catch (err: any) {
    console.error('List audit logs error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list audit logs',
    });
  }
});

// ===========================================================================
// GET /api/audit-logs/:entityType/:entityId - Get audit history for entity
// Access: owner only
// ===========================================================================
router.get('/:entityType/:entityId', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { entityType, entityId } = req.params;

    const logs = await prisma.auditLog.findMany({
      where: {
        branchId,
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'asc' }, // Chronological for entity history
      select: {
        id: true,
        actionType: true,
        userId: true,
        oldValues: true,
        newValues: true,
        createdAt: true,
      },
    });

    // Parse JSON strings
    const parsedLogs = logs.map((log) => ({
      ...log,
      oldValues: log.oldValues ? JSON.parse(log.oldValues) : null,
      newValues: log.newValues ? JSON.parse(log.newValues) : null,
    }));

    return res.json({
      entityType,
      entityId,
      history: parsedLogs,
      count: parsedLogs.length,
    });
  } catch (err: any) {
    console.error('Get entity audit history error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get entity audit history',
    });
  }
});

export default router;

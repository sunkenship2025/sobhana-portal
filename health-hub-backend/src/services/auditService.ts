import { PrismaClient, AuditActionType } from '@prisma/client';

const prisma = new PrismaClient();

export interface AuditLogInput {
  branchId: string;
  actionType: AuditActionType;
  entityType: string;
  entityId: string;
  userId?: string | null;
  oldValues?: any;
  newValues?: any;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * CRITICAL: AuditLog is INSERT-ONLY
 * NEVER update or delete audit log entries
 */
export async function logAction(data: AuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        branchId: data.branchId,
        actionType: data.actionType,
        entityType: data.entityType,
        entityId: data.entityId,
        userId: data.userId,
        oldValues: data.oldValues ? JSON.stringify(data.oldValues) : null,
        newValues: data.newValues ? JSON.stringify(data.newValues) : null,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent
      }
    });
  } catch (err) {
    // Log audit failures but don't block main operation
    console.error('Audit log failed:', err);
  }
}

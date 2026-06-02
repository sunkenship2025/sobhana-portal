import { AuditActionType } from '@prisma/client';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';


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

function hashSensitiveValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeAuditPayload(payload: any): any {
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeAuditPayload(item));
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => {
      if (typeof value === 'string' && key.toLowerCase().includes('token')) {
        return [key, `sha256:${hashSensitiveValue(value)}`];
      }

      return [key, sanitizeAuditPayload(value)];
    })
  );
}

/**
 * CRITICAL: AuditLog is INSERT-ONLY
 * NEVER update or delete audit log entries
 */
export async function logAction(data: // @ts-ignore
AuditLogInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        branchId: data.branchId,
        actionType: data.actionType,
        entityType: data.entityType,
        entityId: data.entityId,
        userId: data.userId,
        oldValues: data.oldValues ? JSON.stringify(sanitizeAuditPayload(data.oldValues)) : null,
        newValues: data.newValues ? JSON.stringify(sanitizeAuditPayload(data.newValues)) : null,
        ipAddress: data.ipAddress,
        userAgent: data.userAgent
      }
    });
  } catch (err) {
    // Log audit failures but don't block main operation. Audit-write failure
    // is operationally significant (compliance gap) but must never break the
    // user-facing action.
    logger.error(
      {
        err,
        actionType: data.actionType,
        entityType: data.entityType,
        entityId: data.entityId,
        userId: data.userId,
        branchId: data.branchId,
      },
      'Audit log write failed',
    );
  }
}

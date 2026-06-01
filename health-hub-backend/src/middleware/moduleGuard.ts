import { Response, NextFunction } from 'express';
import { LRUCache } from 'lru-cache';
import { getCurrentTenantId } from '../lib/tenantContext';
import prisma from '../lib/prisma';
import { AuthRequest } from './auth';

const cache = new LRUCache<string, Set<string>>({ max: 50, ttl: 60_000 });

export function requireModule(...moduleCodes: string[]) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const tenantId = getCurrentTenantId();
    if (!tenantId) return next(); // platform admin bypasses

    let enabled = cache.get(tenantId);
    if (!enabled) {
      // @ts-ignore Prisma types
      const modules = await (prisma as any).tenantModule.findMany({
        where: { tenantId, isEnabled: true },
        select: { moduleCode: true },
      });
      enabled = new Set(modules.map((m: any) => m.moduleCode)) as Set<string>;
      cache.set(tenantId, enabled);
    }

    if (!moduleCodes.some(c => enabled!.has(c))) {
      return res.status(403).json({
        error: 'MODULE_NOT_ENABLED',
        message: `Required module not enabled for your organization`,
      });
    }
    next();
  };
}

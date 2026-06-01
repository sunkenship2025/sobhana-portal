import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { tenantContext } from '../lib/tenantContext';
import { AuthRequest } from './auth';

export const tenantContextMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user) {
    // Public routes that bypass auth won't have req.user.
    // They either don't need tenant context, or resolve it manually (e.g. public report view).
    return next();
  }

  let tenantId = req.user.tenantId;
  // @ts-ignore Prisma types don't always catch the new extension in time.

  if (!tenantId) {
    // Legacy JWT — graceful lookup instead of 401
    const user = await (prisma as any).user.findUnique({
      where: { id: req.user.id },
      select: { tenantId: true },
    });
    if (!user?.tenantId) {
      return res.status(403).json({ error: 'TENANT_NOT_RESOLVED' });
    }
    tenantId = user.tenantId;

    // Issue refreshed token so client updates
    const tenant = await (prisma as any).tenant.findUnique({ where: { id: tenantId } });
    if (tenant) {
        const payload = { ...req.user, tenantId, tenantSlug: tenant.slug };
        const newToken = jwt.sign(payload, process.env.JWT_SECRET!);
        res.setHeader('X-Refreshed-Token', newToken);
    }
  }

  // Wrap remaining middleware + route handler in tenant context
  if (!tenantId) {
    return res.status(403).json({ error: 'TENANT_NOT_RESOLVED' });
  }
  tenantContext.run({ tenantId }, () => next());
};

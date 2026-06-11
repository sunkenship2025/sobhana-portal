import { Router } from 'express';
import prisma from '../lib/prisma';
import { defaultTenantSlug, normalizeTenantSlug, tenantSlugFromHost } from '../lib/tenantResolution';

const router = Router();

router.get('/tenant', async (req, res) => {
  const slug =
    normalizeTenantSlug(req.query.slug) ||
    tenantSlugFromHost(req.query.host) ||
    tenantSlugFromHost(req.get('host')) ||
    defaultTenantSlug();

  try {
    const tenant = await (prisma as any).tenant.findFirst({
      where: { slug, isActive: true },
      include: {
        config: true,
        branding: true,
        modules: true,
        reportTemplates: {
          where: { isActive: true, templateKey: 'default' },
          take: 1,
        },
      },
    });

    if (!tenant) {
      return res.status(404).json({
        error: 'TENANT_NOT_FOUND',
        message: `No active tenant found for '${slug}'`,
      });
    }

    return res.json({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      config: tenant.config,
      branding: tenant.branding,
      modules: tenant.modules.map((module: any) => ({
        moduleCode: module.moduleCode,
        isEnabled: module.isEnabled,
        config: module.config,
      })),
      reportTemplate: tenant.reportTemplates?.[0] || null,
    });
  } catch (err: any) {
    (req as any).log?.error?.({ err, slug }, 'tenant lookup failed') ?? console.error('Tenant lookup failed:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to resolve tenant',
    });
  }
});

export default router;

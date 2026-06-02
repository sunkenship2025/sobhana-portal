import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { invalidateCache } from '../services/tenantAssetResolver';

const router = Router();

// Ensure only platform admins can access this (e.g. system-master admins).
// For now, we reuse requireRole('admin') which allows tenant admins.
// To truly restrict to platform admin, we'd check req.user.tenantId === 'sys-master'.
const requirePlatformAdmin = async (req: AuthRequest, res: Response, next: any) => {
    if (req.user?.tenantId !== 'sys-master') {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Platform admin only' });
        return;
    }
    next();
};

router.use(requireRole('admin'));
router.use(requirePlatformAdmin);

// Create Tenant
router.post('/tenants', async (req: AuthRequest, res) => {
    try {
        const { slug, name } = req.body;
        const tenant = await (prisma as any).tenant.create({
            data: { slug, name }
        });
        res.status(201).json(tenant);
    } catch (err: any) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

// Update Config
router.put('/tenants/:id/config', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = req.body;

        const config = await (prisma as any).tenantConfig.upsert({
            where: { tenantId: id },
            update: data,
            create: { ...data, tenantId: id }
        });
        invalidateCache(id);
        res.json(config);
    } catch (err: any) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

// Update Branding
router.put('/tenants/:id/branding', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = req.body;
        // If this used multipart/form-data for logos, we would use multer here.
        // For now, assuming base64 strings in JSON.
        const branding = await (prisma as any).tenantBranding.upsert({
            where: { tenantId: id },
            update: data,
            create: { ...data, tenantId: id }
        });
        invalidateCache(id);
        res.json(branding);
    } catch (err: any) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});



// Update Modules
router.post('/tenants/:id/modules', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const modulesData: { moduleCode: string; isEnabled: boolean }[] = req.body;

        // Upsert all modules sent in the array
        const ops = modulesData.map(m => (prisma as any).tenantModule.upsert({
            where: { tenantId_moduleCode: { tenantId: id, moduleCode: m.moduleCode } },
            update: { isEnabled: m.isEnabled },
            create: { tenantId: id, moduleCode: m.moduleCode, isEnabled: m.isEnabled }
        }));

        await prisma.$transaction(ops);
        invalidateCache(id);
        res.json({ success: true });
    } catch (err: any) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

// Update Report Template
router.post('/tenants/:id/report-template', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = req.body;

        const template = await (prisma as any).tenantReportTemplate.upsert({
            where: { tenantId_templateKey: { tenantId: id, templateKey: 'default' } },
            update: data,
            create: { ...data, tenantId: id, templateKey: 'default' }
        });
        invalidateCache(id);
        res.json(template);
    } catch (err: any) {
        res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
    }
});

export default router;

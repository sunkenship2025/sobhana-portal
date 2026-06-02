import { z } from 'zod';
import { Router, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { invalidateCache } from '../services/tenantAssetResolver';


const CreateTenantSchema = z.object({
  slug: z.string().min(2),
  name: z.string().min(2),
});

const UpdateConfigSchema = z.object({
  businessName: z.string().min(2),
  businessSubtitle: z.string().optional(),
  contactPhone: z.string().optional(),
  contactAddress: z.string().optional(),
  labLicenseNo: z.string().optional(),
  numberPrefix: z.string().optional(),
  reportPageSize: z.string().optional(),
});

const UpdateBrandingSchema = z.object({
  primaryColor: z.string().optional(),
  accentColor: z.string().optional(),
  sidebarBg: z.string().optional(),
  sidebarActiveBg: z.string().optional(),
  bannerBg: z.string().optional(),
  reportLogoBase64: z.string().optional(),
  portalLogoBase64: z.string().optional(),
  reportFontFamily: z.string().optional(),
});

const UpdateModulesSchema = z.array(z.object({
  moduleCode: z.string(),
  isEnabled: z.boolean(),
}));

const UpdateReportTemplateSchema = z.object({
  customCss: z.string().nullable().optional(),
  headerHtml: z.string().nullable().optional(),
  footerHtml: z.string().nullable().optional(),
  marginTopMm: z.number().optional(),
  marginBottomMm: z.number().optional(),
  marginLeftMm: z.number().optional(),
  marginRightMm: z.number().optional(),
  showLabIncharge: z.boolean().optional(),
  showQrCode: z.boolean().optional(),
  signaturePosition: z.string().optional(),
});

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
        const parsed = CreateTenantSchema.parse(req.body);
        const { slug, name } = parsed;
        const tenant = await (prisma as any).tenant.create({
            data: { slug, name }
        });
        res.status(201).json(tenant);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
        } else {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
        }
    }
});

// Update Config
router.put('/tenants/:id/config', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = UpdateConfigSchema.parse(req.body);

        const config = await (prisma as any).tenantConfig.upsert({
            where: { tenantId: id },
            update: data,
            create: { ...data, tenantId: id }
        });
        invalidateCache(id);
        res.json(config);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
        } else {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
        }
    }
});

// Update Branding
router.put('/tenants/:id/branding', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = UpdateBrandingSchema.parse(req.body);
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
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
        } else {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
        }
    }
});



// Update Modules
router.post('/tenants/:id/modules', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const modulesData = UpdateModulesSchema.parse(req.body);

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
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
        } else {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
        }
    }
});

// Update Report Template
router.post('/tenants/:id/report-template', async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const data = UpdateReportTemplateSchema.parse(req.body);

        const template = await (prisma as any).tenantReportTemplate.upsert({
            where: { tenantId_templateKey: { tenantId: id, templateKey: 'default' } },
            update: data,
            create: { ...data, tenantId: id, templateKey: 'default' }
        });
        invalidateCache(id);
        res.json(template);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            res.status(400).json({ error: 'VALIDATION_ERROR', details: err.errors });
        } else {
            res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
        }
    }
});

export default router;

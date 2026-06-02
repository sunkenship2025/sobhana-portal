import { LRUCache } from 'lru-cache';
import prisma from '../lib/prisma';

// Use 'any' as fallback until Prisma types are regenerated in the outer environment.
export interface TenantRenderAssets {
  tenantId: string;
  tenantSlug: string;
  businessName: string;
  businessSubtitle: string | null;
  contactPhone: string | null;
  contactAddress: string | null;
  labLicenseNo: string | null;
  reportLogoBase64: string;
  primaryColor: string;
  accentColor: string;
  reportFontFamily: string;
  customCss: string | null;
  headerHtml: string | null;
  footerHtml: string | null;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  reportPageSize: string;
  showLabIncharge: boolean;
  showQrCode: boolean;
  signaturePosition: string;
}

const cache = new LRUCache<string, TenantRenderAssets>({ max: 50, ttl: 300_000 });

function mapToRenderAssets(tenant: any): TenantRenderAssets {
  const config = tenant.config;
  const branding = tenant.branding;
  const template = tenant.reportTemplates?.[0];

  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    businessName: config?.businessName || tenant.name,
    businessSubtitle: config?.businessSubtitle || null,
    contactPhone: config?.contactPhone || null,
    contactAddress: config?.contactAddress || null,
    labLicenseNo: config?.labLicenseNo || null,
    reportLogoBase64: branding?.reportLogoBase64 || '',
    primaryColor: branding?.primaryColor || '#1B2B58',
    accentColor: branding?.accentColor || '#D91C2B',
    reportFontFamily: branding?.reportFontFamily || "'Segoe UI', Tahoma, sans-serif",
    customCss: template?.customCss || null,
    headerHtml: template?.headerHtml || null,
    footerHtml: template?.footerHtml || null,
    marginTopMm: template?.marginTopMm ?? 10,
    marginBottomMm: template?.marginBottomMm ?? 15,
    marginLeftMm: template?.marginLeftMm ?? 10,
    marginRightMm: template?.marginRightMm ?? 10,
    reportPageSize: config?.reportPageSize || 'A4',
    showLabIncharge: template?.showLabIncharge ?? true,
    showQrCode: template?.showQrCode ?? false,
    signaturePosition: template?.signaturePosition || 'bottom',
  };
}

export async function resolveTenantAssets(tenantId: string): Promise<TenantRenderAssets> {
  const cached = cache.get(tenantId);
  if (cached) return cached;

  const tenant = await (prisma as any).tenant.findUniqueOrThrow({
    where: { id: tenantId },
    include: {
      config: true,
      branding: true,
      reportTemplates: { where: { isActive: true, templateKey: 'default' }, take: 1 },
    },
  });

  const assets = mapToRenderAssets(tenant);
  cache.set(tenantId, assets);
  return assets;
}

export function invalidateCache(tenantId: string): void {
  cache.delete(tenantId);
}

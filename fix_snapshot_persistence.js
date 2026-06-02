const fs = require('fs');

let snapshotSvc = fs.readFileSync('health-hub-backend/src/services/reportSnapshotService.ts', 'utf8');

// The linter fix script completely reverted the `saveReportSnapshot` modifications I made in `fix_snapshot.js`.
// Let's re-implement `saveReportSnapshot` and uncomment `resolveTenantAssets`.

snapshotSvc = snapshotSvc.replace(
  /\/\/ import \{ resolveTenantAssets \} from '\.\/tenantAssetResolver';/,
  "import { resolveTenantAssets } from './tenantAssetResolver';"
);

// We need to fetch tenant assets before update
const saveBodyOld = `  const slimLabIncharge = snapshot.labIncharge
    ? { ...snapshot.labIncharge, signatureImageBase64: undefined }
    : null;

  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      panelsSnapshot: snapshot.departments as any,
      signaturesSnapshot: slimSignatures as any,
      labInchargeSnapshot: slimLabIncharge as any,
      patientSnapshot: snapshot.patient as any,
      visitSnapshot: snapshot.visit as any,
      externalUploadsSnapshot: snapshot.externalUploads as any,
    },
  });
}`;

const saveBodyNew = `  const slimLabIncharge = snapshot.labIncharge
    ? { ...snapshot.labIncharge, signatureImageBase64: undefined }
    : null;

  // Capture tenant branding exactly as it looks right now
  const tenantAssets = await resolveTenantAssets((snapshot.visit as any)?.tenantId || 'sobhana-default');
  const tenantBrandingSnapshot = {
    businessName: tenantAssets.businessName,
    businessSubtitle: tenantAssets.businessSubtitle,
    contactPhone: tenantAssets.contactPhone,
    contactAddress: tenantAssets.contactAddress,
    labLicenseNo: tenantAssets.labLicenseNo,
    reportLogoBase64: tenantAssets.reportLogoBase64,
    primaryColor: tenantAssets.primaryColor,
    accentColor: tenantAssets.accentColor,
    reportFontFamily: tenantAssets.reportFontFamily,
    customCss: tenantAssets.customCss,
    headerHtml: tenantAssets.headerHtml,
    footerHtml: tenantAssets.footerHtml,
    marginTopMm: tenantAssets.marginTopMm,
    marginBottomMm: tenantAssets.marginBottomMm,
    marginLeftMm: tenantAssets.marginLeftMm,
    marginRightMm: tenantAssets.marginRightMm,
    reportPageSize: tenantAssets.reportPageSize,
    showLabIncharge: tenantAssets.showLabIncharge,
    showQrCode: tenantAssets.showQrCode,
    signaturePosition: tenantAssets.signaturePosition,
  };

  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      panelsSnapshot: snapshot.departments as any,
      signaturesSnapshot: slimSignatures as any,
      labInchargeSnapshot: slimLabIncharge as any,
      patientSnapshot: snapshot.patient as any,
      visitSnapshot: snapshot.visit as any,
      externalUploadsSnapshot: snapshot.externalUploads as any,
      tenantBrandingSnapshot: tenantBrandingSnapshot as any,
    },
  });
}`;

snapshotSvc = snapshotSvc.replace(saveBodyOld, saveBodyNew);

fs.writeFileSync('health-hub-backend/src/services/reportSnapshotService.ts', snapshotSvc);

// Let's also fix the property access bug in reports.ts
let reports = fs.readFileSync('health-hub-backend/src/routes/diagnosticVisits/reports.ts', 'utf8');

// I injected `((loaded as any)?.tenantBrandingSnapshot)` instead of `loaded.snapshot.tenantBrandingSnapshot`
reports = reports.replace(
  /\(\(loaded as any\)\?\.\tenantBrandingSnapshot\)/g,
  "((loaded as any)?.snapshot?.tenantBrandingSnapshot)"
);
fs.writeFileSync('health-hub-backend/src/routes/diagnosticVisits/reports.ts', reports);


// Let's also fix reportDownload.ts
let reportDownload = fs.readFileSync('health-hub-backend/src/routes/reportDownload.ts', 'utf8');
reportDownload = reportDownload.replace(
  /\(\(version as any\)\.tenantBrandingSnapshot\)/g,
  "((snapshot as any).tenantBrandingSnapshot)"
);
fs.writeFileSync('health-hub-backend/src/routes/reportDownload.ts', reportDownload);

// Now for missing platform routes
let platformRoutes = fs.readFileSync('health-hub-backend/src/routes/platform.ts', 'utf8');
if (!platformRoutes.includes('/tenants/:id/modules')) {
    const additionalEndpoints = `

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
`;
    platformRoutes = platformRoutes.replace("export default router;", additionalEndpoints + "\nexport default router;");
    fs.writeFileSync('health-hub-backend/src/routes/platform.ts', platformRoutes);
}

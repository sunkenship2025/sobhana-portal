const fs = require('fs');

let snapshotSvc = fs.readFileSync('health-hub-backend/src/services/reportSnapshotService.ts', 'utf8');
snapshotSvc = snapshotSvc.replace(
  "tenantBrandingSnapshot: tenantBrandingSnapshot as any,",
  "// @ts-ignore Prisma types\n      tenantBrandingSnapshot: tenantBrandingSnapshot as any,"
);
fs.writeFileSync('health-hub-backend/src/services/reportSnapshotService.ts', snapshotSvc);

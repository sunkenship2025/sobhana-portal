import { PrismaClient } from '@prisma/client';
import { getCurrentTenantId } from './tenantContext';

const TENANT_MODELS = new Set([
  'Patient', 'Branch', 'User', 'Visit', 'Bill', 'TestOrder',
  'TestResult', 'DiagnosticReport', 'ReportVersion', 'ClinicVisit',
  'ReferralDoctor', 'ClinicDoctor', 'Department', 'LabTest',
  'BillableProduct', 'ClinicalPanel', 'TestDefinition',
  'SigningDoctor', 'SigningLabIncharge', 'AuditLog',
  'NumberSequence', 'PanelDefinition', 'DiagnosticReferralCenter',
  'DoctorPayoutLedger', 'PaymentTransaction', 'ExternalReportUpload',
  'ReferralDoctor_Visit', 'DiagnosticCenter_Visit',
  'PatientIdentifier', 'ReferralDoctorProductRule',
  'DiagnosticCenterProductRule', 'PanelTestItem', 'ClinicalPanelItem',
  'BillableProductPanel', 'SigningRule', 'LabInchargeRule',
  'ProductBranchPricing', 'DoctorPayoutRule',
  'TestAgeRange', 'TestDefinitionRange', 'InterpretationRule',
  'InterpretationTemplate', 'DerivedParameter', 'DerivedParameterDef',
  'TestInputConfig', 'PatientChangeLog', 'MessageLog',
  'ReportAccessToken', 'ReportAccessLog',
]);

const basePrisma = new PrismaClient();

const prisma = basePrisma.$extends({
  query: {
    async $allOperations({ model, operation, args, query }) {
      const tenantId = getCurrentTenantId();
      if (!tenantId || !model || !TENANT_MODELS.has(model)) return query(args);

      // We explicitly cast args to 'any' for the duration of this middleware
      // to avoid complex TypeScript intersection errors with Prisma types.
      const queryArgs: any = args || {};

            // Reads: inject WHERE tenantId
      if (['findMany','findFirst','count','aggregate','groupBy','updateMany','deleteMany'].includes(operation)) {
        queryArgs.where = { ...queryArgs.where, tenantId };
      }

      // Convert findUnique to findFirst to allow injecting tenantId
      if (['findUnique', 'findUniqueOrThrow'].includes(operation)) {
        queryArgs.where = { ...queryArgs.where, tenantId };
        const result = await (basePrisma as any)[model].findFirst(queryArgs);
        if (operation === 'findUniqueOrThrow' && !result) {
            throw new Error('Record not found');
        }
        return result;
      }

      // Creates: inject tenantId into data
      if (operation === 'create') {
        queryArgs.data = { ...queryArgs.data, tenantId };
      }
      if (operation === 'createMany') {
        const rows = Array.isArray(queryArgs.data) ? queryArgs.data : [queryArgs.data];
        queryArgs.data = rows.map((d: any) => ({ ...d, tenantId }));
      }

      // Update/delete: inject WHERE + data for upsert
      if (['update','delete'].includes(operation)) {
        queryArgs.where = { ...queryArgs.where, tenantId };
      }
      if (operation === 'upsert') {
        queryArgs.where = { ...queryArgs.where, tenantId };
        queryArgs.create = { ...queryArgs.create, tenantId };
      }

      return query(queryArgs);
    },
  },
});

export default prisma;

/**
 * Visit-level gate. Smart Reports are a property of the PACKAGE, not the visit:
 * a one-off Lipid Profile produces nothing, a Master Health Check does.
 *
 * Scope resolves from TestOrder.productId / panelId (frozen at billing), never
 * the live catalog — so a later catalog edit cannot rewrite an old report.
 */
import prisma from '../../lib/prisma';
import { checkPackage } from './packageEligibility';

export type SkipReason =
  | 'DISABLED' | 'LINK_DISABLED' | 'NO_SMART_REPORT_PRODUCT'
  | 'PACKAGE_NO_LONGER_ELIGIBLE' | 'PATIENT_BELOW_MIN_AGE'
  | 'NO_ANALYSABLE_TESTS' | 'BELOW_MIN_PARAMETERS';

export interface VisitScope {
  ok: boolean;
  skipReason?: SkipReason;
  inScopePanelIds: Set<string>;
  packageNames: string[];
  patientAgeYears: number | null;
}

export async function resolveVisitScope(
  visitId: string,
  cfg: { minPatientAgeYears: number },
): Promise<VisitScope> {
  const empty = { inScopePanelIds: new Set<string>(), packageNames: [], patientAgeYears: null };

  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      patientLinkDisabledAt: true,
      patient: { select: { yearOfBirth: true, dateOfBirth: true } },
      testOrders: {
        where: { cancelledAt: null, noReportAt: null },
        select: { productId: true, panelId: true },
      },
    },
  });
  if (!visit) return { ok: false, skipReason: 'NO_SMART_REPORT_PRODUCT', ...empty };
  if (visit.patientLinkDisabledAt) return { ok: false, skipReason: 'LINK_DISABLED', ...empty };

  const ageYears = ageInYears(visit.patient.yearOfBirth, visit.patient.dateOfBirth);
  if (ageYears !== null && ageYears < cfg.minPatientAgeYears) {
    return { ok: false, skipReason: 'PATIENT_BELOW_MIN_AGE', ...empty, patientAgeYears: ageYears };
  }

  const productIds = [...new Set(visit.testOrders.map((o) => o.productId).filter(Boolean))] as string[];
  if (!productIds.length) {
    return { ok: false, skipReason: 'NO_SMART_REPORT_PRODUCT', ...empty, patientAgeYears: ageYears };
  }

  const enabled = await prisma.billableProduct.findMany({
    where: { id: { in: productIds }, smartReportEnabled: true },
    select: { id: true, name: true },
  });
  if (!enabled.length) {
    return { ok: false, skipReason: 'NO_SMART_REPORT_PRODUCT', ...empty, patientAgeYears: ageYears };
  }

  // Re-validate rather than trusting a flag that may have gone stale after a panel edit.
  const stillValid: typeof enabled = [];
  for (const p of enabled) {
    const check = await checkPackage(p.id);
    if (check.eligible) stillValid.push(p);
  }
  if (!stillValid.length) {
    return { ok: false, skipReason: 'PACKAGE_NO_LONGER_ELIGIBLE', ...empty, patientAgeYears: ageYears };
  }

  const validIds = new Set(stillValid.map((p) => p.id));
  const inScopePanelIds = new Set(
    visit.testOrders
      .filter((o) => o.productId && validIds.has(o.productId) && o.panelId)
      .map((o) => o.panelId as string),
  );

  return {
    ok: true,
    inScopePanelIds,
    packageNames: stillValid.map((p) => p.name),
    patientAgeYears: ageYears,
  };
}

function ageInYears(yearOfBirth: number, dob: Date | null): number | null {
  if (dob) return Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000));
  if (!yearOfBirth) return null;
  return new Date().getFullYear() - yearOfBirth;
}

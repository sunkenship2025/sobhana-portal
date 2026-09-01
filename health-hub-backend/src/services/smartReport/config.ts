import prisma from '../../lib/prisma';

export type SmartConfig = {
  enabled: boolean; recommendationsEnabled: boolean; futureTestsEnabled: boolean;
  trendsEnabled: boolean; essentialsEnabled: boolean; language: string;
  accentColor: string; tagline: string | null; websiteLine: string | null;
  disclaimerOverride: string | null; minScoredParameters: number;
  minPatientAgeYears: number; maxFindingPages: number; model: string;
  excludedTestCodes: string[];
};

const DEFAULTS: SmartConfig = {
  enabled: false, recommendationsEnabled: true, futureTestsEnabled: true,
  trendsEnabled: true, essentialsEnabled: true, language: 'en',
  accentColor: '#1E6CA8', tagline: null, websiteLine: null,
  disclaimerOverride: null, minScoredParameters: 5,
  minPatientAgeYears: 18, maxFindingPages: 3, model: 'deepseek-v4-flash',
  excludedTestCodes: ['CUE_QTY', 'CUE_COL', 'CUE_APP', 'CUE_RXN', 'CUE_SG'],
};

/** Branch row wins over the global (null-branch) row — same ladder as referral rates. */
export async function loadConfig(branchId?: string | null): Promise<SmartConfig> {
  const rows = await prisma.smartReportConfig.findMany({
    where: { OR: [{ branchId: null }, ...(branchId ? [{ branchId }] : [])] },
  });
  const chosen = rows.find((r) => r.branchId === branchId) ?? rows.find((r) => r.branchId === null);
  if (!chosen) return DEFAULTS;
  const { id, branchId: _b, updatedAt, monthlyBudgetPaise, ...rest } = chosen as any;
  return { ...DEFAULTS, ...rest };
}

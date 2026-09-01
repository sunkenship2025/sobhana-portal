/** Assemble RenderInput from stored rows. Shared by staff preview and the public route. */
import prisma from '../../lib/prisma';
import { loadConfig } from './config';
import { renderSmartReportHtml, type RenderInput } from './renderer';

export async function buildRenderInput(
  reportVersionId: string,
  qrDataUrl?: string,
): Promise<RenderInput | null> {
  const sr = await prisma.smartReport.findUnique({
    where: { reportVersionId },
    select: {
      status: true, score: true, scoreBand: true, hasCritical: true,
      findings: true, content: true, branchId: true,
      reportVersion: { select: { patientSnapshot: true, visitSnapshot: true } },
    },
  });
  if (!sr || sr.status !== 'READY' || !sr.findings || !sr.content) return null;

  const f = sr.findings as any;
  const patientSnap = (sr.reportVersion.patientSnapshot ?? {}) as any;
  const visitSnap = (sr.reportVersion.visitSnapshot ?? {}) as any;
  const cfg = await loadConfig(sr.branchId);

  // height/weight are live on Patient (captured in billing), not in the snapshot
  const patient = await prisma.patient.findUnique({
    where: { id: patientSnap.patientId ?? '' },
    select: { heightCm: true, weightKg: true },
  }).catch(() => null);

  const genderLabel = patientSnap.gender === 'F' ? 'Female' : patientSnap.gender === 'M' ? 'Male' : 'Other';
  const reportDate = visitSnap.finalizedAt
    ? new Date(visitSnap.finalizedAt).toLocaleDateString('en-GB').replace(/\//g, '-')
    : '';

  return {
    patient: {
      name: [titleOf(patientSnap.title), patientSnap.name].filter(Boolean).join(' '),
      genderLabel,
      ageDisplay: patientSnap.ageDisplay ?? '',
      patientNumber: patientSnap.patientNumber ?? '',
      heightCm: patient?.heightCm ?? null,
      weightKg: patient?.weightKg ?? null,
      ageYears: typeof patientSnap.age === 'number' ? patientSnap.age : null,
      sex: patientSnap.gender ?? 'O',
    },
    visit: {
      billNumber: visitSnap.billNumber ?? '',
      branchName: visitSnap.branchName ?? '',
      branchAddress: visitSnap.branchAddress ?? null,
      branchPhone: visitSnap.branchPhone ?? null,
      reportDate,
    },
    brand: {
      tagline: cfg.tagline ?? 'Accurate Results, Explained Simply',
      website: cfg.websiteLine ?? '',
      accent: cfg.accentColor,
      disclaimer: cfg.disclaimerOverride,
    },
    packageName: (f.packageNames ?? []).join(' + ') || 'your package',
    score: sr.score ?? 0,
    band: (sr.scoreBand ?? 'NEEDS_WORK') as any,
    counts: f.counts,
    hasCritical: sr.hasCritical,
    findings: f.findings ?? [],
    qualitative: f.qualitative ?? [],
    referred: f.referred ?? [],
    panels: f.panels ?? [],
    followUps: f.followUps ?? [],
    content: sr.content as any,
    advisorySuppressed: Boolean(f.advisorySuppressed),
    adviceAiWritten: Boolean(f.adviceAiWritten),
    essentialsEnabled: cfg.essentialsEnabled,
    qrDataUrl,
  };
}

export async function renderStored(reportVersionId: string, qrDataUrl?: string): Promise<string | null> {
  const input = await buildRenderInput(reportVersionId, qrDataUrl);
  return input ? renderSmartReportHtml(input) : null;
}

function titleOf(t?: string | null): string {
  const map: Record<string, string> = { MR: 'Mr.', MRS: 'Mrs.', MS: 'Ms.', MASTER: 'Master', BABY: 'Baby' };
  return t ? map[t] ?? '' : '';
}

/**
 * Same mapping, but from a draft: an ephemeral snapshot plus a produceSmartReport
 * result, with nothing read back from a SmartReport row because none exists.
 * Deliberately shares renderSmartReportHtml with the stored path so a draft and
 * the eventual real report cannot look different.
 */
export async function renderDraft(
  snapshot: any,
  produced: { buckets: any; score: any; content: any; generated: any; advisoryOn: boolean; adviceAiWritten?: boolean },
  scope: { packageNames: string[] },
  cfg: Awaited<ReturnType<typeof loadConfig>>,
): Promise<string> {
  const patientSnap = snapshot.patient ?? {};
  const visitSnap = snapshot.visit ?? {};
  const patient = await prisma.patient
    .findUnique({ where: { id: patientSnap.patientId ?? '' }, select: { heightCm: true, weightKg: true } })
    .catch(() => null);

  const b = produced.buckets;
  return renderSmartReportHtml({
    patient: {
      name: [titleOf(patientSnap.title), patientSnap.name].filter(Boolean).join(' '),
      genderLabel: patientSnap.gender === 'F' ? 'Female' : patientSnap.gender === 'M' ? 'Male' : 'Other',
      ageDisplay: patientSnap.ageDisplay ?? '',
      patientNumber: patientSnap.patientNumber ?? '',
      heightCm: patient?.heightCm ?? null,
      weightKg: patient?.weightKg ?? null,
      ageYears: typeof patientSnap.age === 'number' ? patientSnap.age : null,
      sex: patientSnap.gender ?? 'O',
    },
    visit: {
      billNumber: visitSnap.billNumber ?? '',
      branchName: visitSnap.branchName ?? '',
      branchAddress: visitSnap.branchAddress ?? null,
      branchPhone: visitSnap.branchPhone ?? null,
      // a draft has no finalized date yet — show today, which is what it would get
      reportDate: new Date().toLocaleDateString('en-GB').replace(/\//g, '-'),
    },
    brand: {
      tagline: cfg.tagline ?? 'Accurate Results, Explained Simply',
      website: cfg.websiteLine ?? '',
      accent: cfg.accentColor,
      disclaimer: cfg.disclaimerOverride,
    },
    packageName: scope.packageNames.join(' + ') || 'your package',
    score: produced.score.score,
    band: produced.score.band,
    counts: b.counts,
    hasCritical: b.hasCritical,
    findings: b.findings,
    qualitative: b.qualitative,
    referred: b.referred,
    panels: b.panels,
    followUps: produced.content.followUps,
    content: produced.generated,
    advisorySuppressed: !produced.advisoryOn,
    adviceAiWritten: produced.adviceAiWritten,
    essentialsEnabled: cfg.essentialsEnabled,
  });
}

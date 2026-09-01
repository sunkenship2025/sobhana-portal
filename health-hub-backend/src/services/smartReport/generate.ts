/**
 * Orchestrator. Called fire-and-forget from the FINAL finalize only — never on a
 * partial release, because scoring half a package is meaningless.
 *
 * Never throws to the caller: a finalize must not be able to fail because of this.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { loadConfig } from './config';
import { resolveVisitScope } from './eligibility';
import { buildBuckets, type SnapshotLike } from './findings';
import { computeScore } from './score';
import { loadPriorValues, attachTrends, loadHistory, attachHistory } from './trends';
import { attachContent } from './content';
import { buildPayload, assertDeidentified, PROMPT_VERSION } from './payload';
import { callModel } from './llm';
import { validate, clampLengths, dropResultClaims, type GeneratedContent } from './validate';
import { templateContent } from './fallback';
import { withSlot } from './queue';

const log = logger.child({ mod: 'smartReport' });


/**
 * Everything between "here is a snapshot" and "here is the finished content".
 *
 * Extracted so the pre-finalize draft preview and the real generation run the
 * SAME pipeline. Two copies would let a patient be shown one summary before
 * finalize and a different one after, which is worse than offering no preview.
 * Persistence stays with the caller; this touches no SmartReport row.
 */
export interface ProduceArgs {
  buckets: ReturnType<typeof buildBuckets>;
  visit: { id: string; createdAt: Date; patientId: string };
  patientSnapshot: any;
  scope: Awaited<ReturnType<typeof resolveVisitScope>>;
  cfg: Awaited<ReturnType<typeof loadConfig>>;
  /** identifies the run in logs — a version id, or a visit id for a draft */
  logRef: string;
}

export async function produceSmartReport(a: ProduceArgs) {
  const cfg = a.cfg;
  const scope = a.scope;
  const buckets = a.buckets;
  if (cfg.trendsEnabled) {
    const priors = await loadPriorValues(a.visit.patientId, a.visit.createdAt, a.visit.id);
    attachTrends(buckets.findings, priors);
    // series for the trend charts; the prior-value line above still covers the
    // common case of a patient with exactly one earlier visit
    attachHistory(buckets.findings, await loadHistory(a.visit.patientId, a.visit.createdAt, a.visit.id));
  }

  // A critical result suppresses the advisory entirely — that patient should be
  // phoning the centre, not reading a diet page.
  const advisoryOn = cfg.recommendationsEnabled && !buckets.hasCritical;
  const content = await attachContent(buckets.findings, cfg.language, {
    recommendations: advisoryOn,
    futureTests: cfg.futureTestsEnabled && !buckets.hasCritical,
  });

  const score = computeScore([...buckets.findings, ...buckets.borderline], buckets.counts.scored);
  const patient = a.patientSnapshot;
  const payload = buildPayload({
    age: a.scope.patientAgeYears,
    sex: patient?.gender ?? 'O',
    packageName: a.scope.packageNames.join(' + ') || 'your package',
    counts: buckets.counts,
    score: score.score,
    scoreBand: score.band,
    findings: buckets.findings,
    contentLines: content.contentLines,
    followUps: content.followUps,
    language: cfg.language,
  });
  assertDeidentified(payload, [
    patient?.name, patient?.patientNumber, patient?.phone, patient?.address,
  ].filter(Boolean));

  let generated: GeneratedContent | null = null;
  let usedFallback = false;
  const failures: string[] = [];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  for (let attempt = 0; attempt < 2 && !generated; attempt += 1) {
    try {
      const res = await withSlot(() => callModel(cfg.model, payload));
      inputTokens = res.inputTokens;
      outputTokens = res.outputTokens;
      const v = validate(dropResultClaims(clampLengths(res.parsed)), payload);
      if (v.ok && v.content) generated = v.content;
      else failures.push(...v.failures.map((f) => `attempt${attempt + 1}: ${f}`));
    } catch (err: any) {
      failures.push(`attempt${attempt + 1}: ${err?.message ?? String(err)}`);
    }
  }

  if (!generated) {
    usedFallback = true;
    generated = templateContent({
      packageName: payload.packageName, counts: buckets.counts,
      score: score.score, band: score.band, findings: buckets.findings,
      contentLines: advisoryOn ? content.contentLines : [],
      followUps: content.followUps,
    });
  } else {
    // Fold generated explanations onto the findings that asked for one.
    const byCode = new Map(generated.findingExplanations.map((e) => [e.code, e.sentence]));
    for (const f of buckets.findings) {
      if (f.needsExplanation && byCode.has(f.code)) f.explanation = byCode.get(f.code) ?? null;
    }
  }

  if (content.matchedCount < buckets.findings.length / 2) {
    log.warn(
      { ref: a.logRef, matched: content.matchedCount, total: buckets.findings.length },
      'smart report content coverage below 50% — catalog needs filling',
    );
  }


  // No catalog line means whatever advice appears is the model's own, which the
  // report has to say out loud rather than let it pass as clinician-authored.
  const adviceAiWritten = advisoryOn && content.contentLines.length === 0
    && (generated.advisory.dietBlocks.length > 0 || generated.advisory.lifestyleBlocks.length > 0);
  return { buckets, score, content, generated, usedFallback, failures, inputTokens, outputTokens, advisoryOn, adviceAiWritten };
}

export async function generateSmartReport(reportVersionId: string): Promise<void> {
  const started = Date.now();
  try {
    const version = await prisma.reportVersion.findUnique({
      where: { id: reportVersionId },
      select: {
        id: true, status: true, panelsSnapshot: true, patientSnapshot: true,
        report: { select: { branchId: true, visit: { select: { id: true, createdAt: true, patientId: true } } } },
      },
    });
    if (!version || version.status !== 'FINALIZED' || !version.panelsSnapshot) return;

    const visit = version.report.visit;
    const branchId = version.report.branchId;
    const cfg = await loadConfig(branchId);

    const base = {
      reportVersionId, visitId: visit.id, patientId: visit.patientId, branchId,
      language: cfg.language, configSnapshot: cfg as any,
    };
    const skip = (skipReason: string) =>
      upsert({ ...base, status: 'SKIPPED' as const, skipReason });

    if (!cfg.enabled) return void (await skip('DISABLED'));

    const scope = await resolveVisitScope(visit.id, cfg);
    if (!scope.ok) return void (await skip(scope.skipReason ?? 'NO_SMART_REPORT_PRODUCT'));

    const snapshot = version.panelsSnapshot as unknown as SnapshotLike;
    const buckets = buildBuckets(
      snapshot,
      scope.inScopePanelIds.size ? scope.inScopePanelIds : null,
      cfg.excludedTestCodes,
    );
    if (buckets.counts.scored === 0) return void (await skip('NO_ANALYSABLE_TESTS'));
    if (buckets.counts.scored < cfg.minScoredParameters) return void (await skip('BELOW_MIN_PARAMETERS'));

    const produced = await produceSmartReport({
      buckets, visit, patientSnapshot: version.patientSnapshot as any,
      scope, cfg, logRef: reportVersionId,
    });
    const { score, content, generated, usedFallback, failures, inputTokens, outputTokens, advisoryOn } = produced;

    await upsert({
      ...base,
      status: 'READY',
      skipReason: null,
      score: score.score,
      scoreBand: score.band,
      scoredCount: buckets.counts.scored,
      outOfRangeCount: buckets.counts.outOfRange,
      borderlineCount: buckets.counts.borderline,
      withinRangeCount: buckets.counts.withinRange,
      shownNotScored: buckets.counts.shownNotScored,
      referredOnly: buckets.counts.referredOnly,
      hasCritical: buckets.hasCritical,
      findings: {
        packageNames: scope.packageNames,
        findings: buckets.findings,
        borderline: buckets.borderline,
        qualitative: buckets.qualitative,
        referred: buckets.referred,
        panels: buckets.panels,
        counts: buckets.counts,
        score,
        followUps: content.followUps,
        advisorySuppressed: !advisoryOn,
      adviceAiWritten: produced.adviceAiWritten,
      } as any,
      content: generated as any,
      usedFallbackCopy: usedFallback,
      validationFailures: failures.length ? (failures as any) : undefined,
      model: cfg.model,
      promptVersion: PROMPT_VERSION,
      inputTokens: inputTokens ?? undefined,
      outputTokens: outputTokens ?? undefined,
      generationMs: Date.now() - started,
      generatedAt: new Date(),
    });

    log.info(
      { reportVersionId, score: score.score, fallback: usedFallback, ms: Date.now() - started },
      'smart report generated',
    );
  } catch (err: any) {
    log.error({ err, reportVersionId }, 'smart report generation failed');
    await upsert({
      reportVersionId,
      status: 'FAILED',
      validationFailures: [String(err?.message ?? err)] as any,
      generationMs: Date.now() - started,
    }).catch(() => undefined);
  }
}

/** Regeneration REPLACES — one Smart Report per report version, by decision. */
async function upsert(data: any): Promise<void> {
  const { reportVersionId, ...rest } = data;
  const existing = await prisma.smartReport.findUnique({
    where: { reportVersionId },
    select: { id: true, visitId: true, patientId: true, branchId: true },
  });
  if (existing) {
    await prisma.smartReport.update({ where: { reportVersionId }, data: rest });
    return;
  }
  if (!rest.visitId) return; // FAILED before we knew the visit — nothing to anchor a row on
  await prisma.smartReport.create({ data: { reportVersionId, ...rest } });
}

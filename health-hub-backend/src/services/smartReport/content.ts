/**
 * Recommendation engine: a JOIN, not a retrieval problem.
 *
 * Catalog text always wins where it exists. Findings with no row are flagged
 * needsExplanation so the model writes ONE "what this test measures" line.
 * Follow-up tests are constrained to products this lab actually sells.
 */
import prisma from '../../lib/prisma';
import type { Finding } from './types';

export interface ContentLine { ruleId: string; kind: 'DIET_DO' | 'DIET_DONT' | 'LIFESTYLE'; text: string }
export interface FollowUp {
  productCode: string; productName: string; weeks: number; becauseOf: string[];
}

function directionOf(status: Finding['status']): 'HIGH' | 'LOW' | null {
  if (status === 'HIGH' || status === 'CRITICAL_HIGH') return 'HIGH';
  if (status === 'LOW' || status === 'CRITICAL_LOW') return 'LOW';
  return null; // BORDERLINE gets no content — it is inside the range
}

export interface ContentResult {
  contentLines: ContentLine[];
  followUps: FollowUp[];
  matchedCount: number;
}

export async function attachContent(
  findings: Finding[],
  language: string,
  opts: { recommendations: boolean; futureTests: boolean },
): Promise<ContentResult> {
  const codes = [...new Set(findings.map((f) => f.code))];
  if (codes.length === 0) return { contentLines: [], followUps: [], matchedCount: 0 };

  const rules = await prisma.healthContentRule.findMany({
    where: { language, testCode: { in: codes }, isActive: true },
  });
  const byKey = new Map(rules.map((r) => [`${r.testCode}|${r.direction}`, r]));

  const contentLines: ContentLine[] = [];
  const wanted = new Map<string, { weeks: number; becauseOf: string[] }>();
  let matchedCount = 0;

  for (const f of findings) {
    const dir = directionOf(f.status);
    if (!dir) continue;
    const rule = byKey.get(`${f.code}|${dir}`) ?? byKey.get(`${f.code}|ANY`);
    if (!rule) continue;

    matchedCount += 1;
    f.ruleId = rule.id;
    f.explanation = rule.whatItMeans;
    f.needsExplanation = false;

    if (opts.recommendations) {
      const push = (kind: ContentLine['kind'], arr: unknown) => {
        for (const text of (arr as string[]) ?? []) {
          if (typeof text === 'string' && text.trim()) {
            contentLines.push({ ruleId: rule.id, kind, text: text.trim() });
          }
        }
      };
      push('DIET_DO', rule.dos);
      push('DIET_DONT', rule.donts);
      push('LIFESTYLE', rule.lifestyle);
    }

    if (opts.futureTests) {
      for (const code of ((rule.suggestedTestCodes as string[]) ?? [])) {
        const weeks = rule.followUpWeeks ?? 12;
        const existing = wanted.get(code);
        if (!existing) wanted.set(code, { weeks, becauseOf: [f.code] });
        else {
          existing.weeks = Math.min(existing.weeks, weeks); // shortest interval wins
          if (!existing.becauseOf.includes(f.code)) existing.becauseOf.push(f.code);
        }
      }
    }
  }

  // Only suggest tests this lab actually sells, and is still selling.
  const followUps: FollowUp[] = [];
  if (wanted.size) {
    const products = await prisma.billableProduct.findMany({
      where: { code: { in: [...wanted.keys()] }, isActive: true },
      select: { code: true, name: true },
    });
    const byCode = new Map(products.map((p) => [p.code, p.name]));
    for (const [code, meta] of wanted) {
      const name = byCode.get(code);
      if (!name) continue; // dropped — logged by the caller as a content-health signal
      followUps.push({ productCode: code, productName: name, weeks: meta.weeks, becauseOf: meta.becauseOf });
    }
    followUps.sort((a, b) => a.weeks - b.weeks);
  }

  return { contentLines: dedupe(contentLines), followUps, matchedCount };
}

/** Two rules can supply the same advice; show it once. Cap so the page stays readable. */
function dedupe(lines: ContentLine[]): ContentLine[] {
  const seen = new Set<string>();
  const out: ContentLine[] = [];
  for (const l of lines) {
    const k = `${l.kind}|${l.text.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, 12);
}

/**
 * Template copy. Used when the model is unavailable or its output is rejected
 * twice. Drier, but every sentence is human-written and already reviewed.
 */
import type { Finding, Counts, ScoreBand } from './types';
import type { ContentLine, FollowUp } from './content';
import type { GeneratedContent } from './validate';
import { BAND_LABEL } from './score';

export function templateContent(input: {
  packageName: string; counts: Counts; score: number; band: ScoreBand;
  findings: Finding[]; contentLines: ContentLine[]; followUps: FollowUp[];
}): GeneratedContent {
  const { counts, score, packageName } = input;
  const bits = [
    `This report covers your ${packageName} package.`,
    `${counts.scored} ${counts.scored === 1 ? 'parameter was' : 'parameters were'} scored, of which ${counts.outOfRange} ${counts.outOfRange === 1 ? 'is' : 'are'} outside the reference range` +
      (counts.borderline ? ` and ${counts.borderline} ${counts.borderline === 1 ? 'is' : 'are'} borderline` : '') + '.',
    `Your test score is ${score} out of 100 (${BAND_LABEL[input.band].toLowerCase()}).`,
    'Please go through the results marked below with your doctor.',
  ];

  const group = (kind: ContentLine['kind']) => input.contentLines.filter((l) => l.kind === kind).map((l) => l.text);
  const dos = group('DIET_DO');
  const donts = group('DIET_DONT');
  const life = group('LIFESTYLE');

  return {
    testScore: { paragraph: bits.join(' ') },
    findingExplanations: [], // no reviewed copy exists for these; say nothing rather than invent
    advisory: {
      dietBlocks: dos.length || donts.length
        ? [{ heading: 'Based on your results', dos: dos.slice(0, 4), donts: donts.slice(0, 4) }]
        : [],
      lifestyleBlocks: life.length
        ? [{ heading: 'Daily habits', dos: life.slice(0, 4), donts: [] }]
        : [],
      followUpReasons: input.followUps.map((f) => ({
        productCode: f.productCode,
        reason: `Suggested because of your ${f.becauseOf.join(', ')} result${f.becauseOf.length > 1 ? 's' : ''}.`,
      })),
    },
  };
}

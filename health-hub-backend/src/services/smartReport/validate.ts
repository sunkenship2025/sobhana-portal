/**
 * Eight checks. Any failure => retry once => second failure => template copy.
 * The report always ships; only the prose degrades.
 */
import { findBanned, NON_LATIN } from './lexicon';
import type { SmartReportPayload } from './payload';

export interface GeneratedContent {
  testScore: { paragraph: string };
  findingExplanations: { code: string; sentence: string }[];
  advisory: {
    dietBlocks: { heading: string; dos: string[]; donts: string[] }[];
    lifestyleBlocks: { heading: string; dos: string[]; donts: string[] }[];
    followUpReasons: { productCode: string; reason: string }[];
  };
}

export interface ValidationResult {
  ok: boolean;
  failures: string[];
  content?: GeneratedContent;
}

const MAX = { paragraph: 480, explanation: 200, line: 160, heading: 60, reason: 160 };

/**
 * Length is a layout concern, not a safety one — a reason two characters over the
 * cap should not discard an otherwise-safe generation the way a named diagnosis
 * must. Callers clamp first, so the checks below only ever fire as a backstop.
 * Trims on a word boundary; never mid-word.
 */
function trim(s: string, max: number): string {
  if (typeof s !== 'string' || s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '');
}

/**
 * Removes explanations that assert this patient's result. Dropping the sentence
 * achieves what rule 9 protects (no unreviewed interpretation) while the rest of
 * the report — score paragraph and catalog-sourced advice — still ships. Failing
 * the whole report over one drifting sentence loses far more than it protects.
 */
export function dropResultClaims(raw: unknown): unknown {
  const c = raw as GeneratedContent;
  if (!c || !Array.isArray(c.findingExplanations)) return raw;
  c.findingExplanations = c.findingExplanations.filter((e) => !statesResult(e.sentence ?? ''));
  return c;
}

function statesResult(s: string): boolean {
  return /\byour\s+(level|result|value|reading|count)\b/i.test(s) || /\byours?\s+is\b/i.test(s);
}

export function clampLengths(raw: unknown): unknown {
  const c = raw as GeneratedContent;
  if (!c || typeof c !== 'object') return raw;
  if (c.testScore?.paragraph) c.testScore.paragraph = trim(c.testScore.paragraph, MAX.paragraph);
  for (const e of c.findingExplanations ?? []) e.sentence = trim(e.sentence, MAX.explanation);
  for (const b of [...(c.advisory?.dietBlocks ?? []), ...(c.advisory?.lifestyleBlocks ?? [])]) {
    b.heading = trim(b.heading, MAX.heading);
    b.dos = (b.dos ?? []).map((l) => trim(l, MAX.line));
    b.donts = (b.donts ?? []).map((l) => trim(l, MAX.line));
  }
  for (const r of c.advisory?.followUpReasons ?? []) r.reason = trim(r.reason, MAX.reason);
  return c;
}

export function validate(raw: unknown, payload: SmartReportPayload): ValidationResult {
  const failures: string[] = [];
  const c = raw as GeneratedContent;

  // 1. shape
  if (!c || typeof c !== 'object') return { ok: false, failures: ['not an object'] };
  if (typeof c.testScore?.paragraph !== 'string') {
    return { ok: false, failures: ['missing testScore.paragraph'] };
  }
  if (!Array.isArray(c.findingExplanations)) c.findingExplanations = [];
  const adv = c.advisory ?? ({} as GeneratedContent['advisory']);
  adv.dietBlocks = adv.dietBlocks ?? [];
  adv.lifestyleBlocks = adv.lifestyleBlocks ?? [];
  adv.followUpReasons = adv.followUpReasons ?? [];
  c.advisory = adv;

  const blob = collectText(c).join('   ');

  // 2. number grounding. Strict wherever a number could be read as a result or a
  //    threshold; 100 is always allowed because the score is defined out of 100.
  //    findingExplanations are exempt because they are definitional by contract
  //    ("measured after 8 hours without food", "average over 2 to 3 months") —
  //    they are instead barred from asserting a result at all, just below.
  const allowed = new Set(JSON.stringify(payload).match(/\d+/g) ?? []);
  allowed.add('100');
  const grounded = [
    c.testScore.paragraph,
    ...adv.dietBlocks.flatMap((b) => [b.heading ?? '', ...(b.dos ?? []), ...(b.donts ?? [])]),
    ...adv.lifestyleBlocks.flatMap((b) => [b.heading ?? '', ...(b.dos ?? []), ...(b.donts ?? [])]),
    ...adv.followUpReasons.map((r) => r.reason ?? ''),
  ].join('   ');
  for (const n of grounded.match(/\d+/g) ?? []) {
    if (!allowed.has(n)) failures.push(`ungrounded number "${n}"`);
  }

  // 2b. an explanation says what a test MEASURES, never what this patient's result
  //     was — the model does drift into "your level is 320 mg/dL" without this.
  for (const e of c.findingExplanations) {
    if (statesResult(e.sentence ?? '')) failures.push(`explanation states a result ("${e.code}")`);
  }

  // 3. banned lexicon. Names the payload itself supplied (package, panel, test)
  //    are stripped first: "Anaemia Profile" is our own product name, and firing
  //    the disease-word rule on it rejected every anaemia package outright.
  for (const hit of findBanned(stripPayloadNames(blob, payload))) {
    failures.push(`banned phrase "${hit}"`);
  }

  // 4. content membership — no advice when none was supplied
  if (payload.contentLines.length === 0 && (adv.dietBlocks.length || adv.lifestyleBlocks.length)) {
    failures.push('advice invented with no content lines supplied');
  }

  // 5. follow-up membership
  const okCodes = new Set(payload.followUps.map((f) => f.productCode));
  for (const r of adv.followUpReasons) {
    if (!okCodes.has(r.productCode)) failures.push(`unknown follow-up "${r.productCode}"`);
  }

  // 6. length caps
  if (c.testScore.paragraph.length > MAX.paragraph) failures.push('testScore too long');
  for (const e of c.findingExplanations) {
    if ((e.sentence ?? '').length > MAX.explanation) failures.push(`explanation too long (${e.code})`);
  }
  for (const b of [...adv.dietBlocks, ...adv.lifestyleBlocks]) {
    if ((b.heading ?? '').length > MAX.heading) failures.push('advisory heading too long');
    for (const l of [...(b.dos ?? []), ...(b.donts ?? [])]) {
      if (l.length > MAX.line) failures.push('advisory line too long');
    }
  }
  for (const r of adv.followUpReasons) {
    if ((r.reason ?? '').length > MAX.reason) failures.push('follow-up reason too long');
  }

  // 7. language
  if (payload.language === 'en' && NON_LATIN.test(blob)) failures.push('non-English output');

  // 8. explanations only for findings that asked for one
  const needs = new Set(payload.findings.filter((f) => f.needsExplanation).map((f) => f.code));
  for (const e of c.findingExplanations) {
    if (!needs.has(e.code)) {
      failures.push(`explanation for "${e.code}" which already has reviewed copy`);
    }
  }

  return failures.length ? { ok: false, failures } : { ok: true, failures: [], content: c };
}

/** Removes payload-supplied proper names so our own catalog wording can't trip the lexicon. */
function stripPayloadNames(blob: string, payload: SmartReportPayload): string {
  const names = [
    payload.packageName,
    ...payload.findings.flatMap((f) => [f.panel, f.name]),
    ...payload.followUps.map((f) => f.productName),
  ].filter((n): n is string => !!n && n.length > 2)
   .sort((a, b) => b.length - a.length);           // longest first, so "Vitamin B12" beats "B12"
  let out = blob;
  for (const n of names) out = out.split(n).join(' ');
  return out;
}

function collectText(c: GeneratedContent): string[] {
  const out = [c.testScore?.paragraph ?? ''];
  for (const e of c.findingExplanations ?? []) out.push(e.sentence ?? '');
  for (const b of [...(c.advisory?.dietBlocks ?? []), ...(c.advisory?.lifestyleBlocks ?? [])]) {
    out.push(b.heading ?? '', ...(b.dos ?? []), ...(b.donts ?? []));
  }
  for (const r of c.advisory?.followUpReasons ?? []) out.push(r.reason ?? '');
  return out.filter(Boolean);
}

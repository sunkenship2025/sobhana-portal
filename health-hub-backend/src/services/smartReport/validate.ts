/**
 * Eight checks. Any failure => retry once => second failure => template copy.
 * The report always ships; only the prose degrades.
 */
import { findBanned, BANNED_OUTSIDE_EXPLANATIONS, NON_LATIN } from './lexicon';
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

// Measured against the rendered A4 pages, not guessed: page 01 overflows at 520
// characters of score paragraph, and the finding pages overflow at 320 per
// explanation. These are layout limits, so raising them silently breaks the PDF.
const MAX = { paragraph: 500, explanation: 280, line: 160, heading: 60, reason: 160 };

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
  // A number in the SCORE PARAGRAPH reads as a result or a threshold, so it must
  // have come from the payload.
  for (const n of c.testScore.paragraph.match(/\d+/g) ?? []) {
    if (!allowed.has(n)) failures.push(`ungrounded number "${n}"`);
  }
  // Advisory lines are different: "walk 30 minutes", "8 hours of sleep", "7 days"
  // are ordinary advice, not claims about this patient. When the catalog is silent
  // — or the advisory is suppressed, so contentLines is empty — the payload carries
  // no numbers at all, and strict grounding rejected every generic suggestion the
  // model made. Small integers pass here; anything dose-shaped is still caught by
  // the banned lexicon (\d+ mg, tablet, capsule, dosage, prescri...).
  const advisoryText = [
    ...adv.dietBlocks.flatMap((b) => [b.heading ?? '', ...(b.dos ?? []), ...(b.donts ?? [])]),
    ...adv.lifestyleBlocks.flatMap((b) => [b.heading ?? '', ...(b.dos ?? []), ...(b.donts ?? [])]),
    ...adv.followUpReasons.map((r) => r.reason ?? ''),
  ].join('   ');
  for (const n of advisoryText.match(/\d+/g) ?? []) {
    if (!allowed.has(n) && Number(n) > 60) failures.push(`ungrounded number "${n}"`);
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
  // Category words (infection, disorder, deficiency, syndrome) are definitional in
  // an explanation and a diagnosis anywhere else, so they are checked only outside
  // findingExplanations. See BANNED_OUTSIDE_EXPLANATIONS.
  const nonExplanatory = [c.testScore.paragraph, advisoryText].join('   ');
  for (const hit of findBanned(stripPayloadNames(nonExplanatory, payload), BANNED_OUTSIDE_EXPLANATIONS)) {
    failures.push(`banned phrase "${hit}"`);
  }

  // 4. content membership. The model MAY now write advice where the catalog
  //    supplied none — Pranav's call, on the basis that a fever panel producing no
  //    advice at all is a worse product. What it may not do is dress an invention
  //    as clinician-authored: when contentLines is empty the advisory is labelled
  //    as AI-written in the report, and the banned-remedy lexicon above is the only
  //    check on WHAT it suggests, since advice quality is not machine-checkable.

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

/**
 * Salvage, not reject. validate() is all-or-nothing, which meant ONE bad sentence
 * threw away an entire good report and shipped clinician-written template copy in
 * its place — production ran usedFallbackCopy on every report because explanations
 * legitimately said "infection". Dropping an offending line is exactly as safe as
 * rejecting the report (the patient never sees it either way) and keeps everything
 * else the model wrote.
 *
 * Returns null content only for damage nothing can be salvaged from: wrong shape,
 * missing score paragraph, or wrong language. Those retry, and only a model that
 * never answers at all reaches the template.
 *
 * `safeParagraph` is the deterministic template score paragraph, substituted when
 * the model's own paragraph is unsafe — it is required copy, so it cannot be dropped.
 */
export function sanitize(
  raw: unknown,
  payload: SmartReportPayload,
  safeParagraph: string,
): { content: GeneratedContent | null; dropped: string[] } {
  const dropped: string[] = [];
  const c = raw as GeneratedContent;
  if (!c || typeof c !== 'object') return { content: null, dropped: ['not an object'] };
  if (!c.testScore || typeof c.testScore.paragraph !== 'string' || !c.testScore.paragraph.trim()) {
    return { content: null, dropped: ['missing testScore.paragraph'] };
  }
  if (!Array.isArray(c.findingExplanations)) c.findingExplanations = [];
  const adv = c.advisory ?? ({} as GeneratedContent['advisory']);
  adv.dietBlocks = adv.dietBlocks ?? [];
  adv.lifestyleBlocks = adv.lifestyleBlocks ?? [];
  adv.followUpReasons = adv.followUpReasons ?? [];
  c.advisory = adv;

  // Language is a whole-output property — there is no per-line salvage.
  if (payload.language === 'en' && NON_LATIN.test(collectText(c).join('   '))) {
    return { content: null, dropped: ['non-English output'] };
  }

  const allowed = new Set(JSON.stringify(payload).match(/\d+/g) ?? []);
  allowed.add('100');
  const clean = (t: string) => stripPayloadNames(t, payload);
  const bannedAnywhere = (t: string) => findBanned(clean(t));
  // Outside an explanation, generic category words read as a diagnosis.
  const bannedHere = (t: string) => [
    ...findBanned(clean(t)),
    ...findBanned(clean(t), BANNED_OUTSIDE_EXPLANATIONS),
  ];
  // Small integers are ordinary advice ("30 minutes", "8 hours"); dose-shaped text
  // is caught by the lexicon, not by grounding.
  const ungrounded = (t: string) =>
    (t.match(/\d+/g) ?? []).filter((n) => !allowed.has(n) && Number(n) > 60);

  // Score paragraph: required, so substitute rather than drop.
  const paraBad = [
    ...bannedHere(c.testScore.paragraph),
    ...(c.testScore.paragraph.match(/\d+/g) ?? []).filter((n) => !allowed.has(n)),
  ];
  if (paraBad.length) {
    dropped.push(`score paragraph replaced (${paraBad.join(', ')})`);
    c.testScore.paragraph = safeParagraph;
  }

  // Explanations: definitional by contract, so category words are allowed here.
  const needs = new Set(payload.findings.filter((f) => f.needsExplanation).map((f) => f.code));
  c.findingExplanations = c.findingExplanations.filter((e) => {
    const hits = bannedAnywhere(e.sentence ?? '');
    if (hits.length) { dropped.push(`explanation ${e.code}: ${hits.join(', ')}`); return false; }
    if (statesResult(e.sentence ?? '')) { dropped.push(`explanation ${e.code}: states a result`); return false; }
    if (!needs.has(e.code)) { dropped.push(`explanation ${e.code}: not requested`); return false; }
    return true;
  });

  const keepLine = (l: string, where: string) => {
    const hits = [...bannedHere(l), ...ungrounded(l).map((n) => `number ${n}`)];
    if (hits.length) { dropped.push(`${where}: ${hits.join(', ')}`); return false; }
    return true;
  };
  const cleanBlocks = (blocks: GeneratedContent['advisory']['dietBlocks'], where: string) =>
    blocks.filter((b) => {
      const bad = bannedHere(b.heading ?? '');
      if (bad.length) { dropped.push(`${where} heading: ${bad.join(', ')}`); return false; }
      b.dos = (b.dos ?? []).filter((l) => keepLine(l, where));
      b.donts = (b.donts ?? []).filter((l) => keepLine(l, where));
      return b.dos.length > 0 || b.donts.length > 0;
    });
  adv.dietBlocks = cleanBlocks(adv.dietBlocks, 'diet');
  adv.lifestyleBlocks = cleanBlocks(adv.lifestyleBlocks, 'lifestyle');

  const okCodes = new Set(payload.followUps.map((f) => f.productCode));
  adv.followUpReasons = adv.followUpReasons.filter((r) => {
    if (!okCodes.has(r.productCode)) { dropped.push(`follow-up ${r.productCode}: unknown`); return false; }
    return keepLine(r.reason ?? '', `follow-up ${r.productCode}`);
  });

  return { content: c, dropped };
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

/**
 * Banned lexicon. Not a vibe — an actual list, versioned with the prompt.
 * Case-insensitive. Any match rejects the generation.
 */
export const BANNED: RegExp[] = [
  // conditions and diagnoses
  /\bdiabet/i, /\bprediabet/i, /\ban[a]?emi/i, /\bhypothyroid/i, /\bhyperthyroid/i,
  /\bthyroiditis\b/i, /\bfatty liver\b/i, /\bhepatitis\b/i, /\bcirrhosis\b/i, /\bjaundice\b/i,
  /\bcancer\b/i, /\bcarcinoma\b/i, /\btumou?r\b/i, /\bmalignan/i, /\bkidney disease\b/i,
  /\brenal failure\b/i, /\bCKD\b/, /\bheart disease\b/i, /\batherosclerosis\b/i,
  /\bhypertension\b/i, /\bgout\b/i, /\bosteoporosis\b/i, /\bdeficiency\b/i, /\bsyndrome\b/i,
  /\bdisorder\b/i, /\binfection\b/i,
  // certainty and causation
  /\byou have\s+(?:a|an|the)?\s*(?:mild|severe|early|chronic|acute)?\s*(?:high|low|elevated|raised|poor|abnormal|too much|too little)\b/i,
  /\byou have\s+(?:a|an|the)?\s*(?:mild|severe|early|chronic|acute)?\s*\w*(?:itis|osis|emia|aemia|opathy|disease|disorder|syndrome|deficiency|infection|condition)\b/i, /\byou are suffering\b/i, /\bindicates that you have\b/i, /\bis caused by\b/i,
  /\bdiagnos/i, /\bconfirms\b/i, /\bconsistent with\b/i,
  // treatment
  /\bprescri/i, /\bdosage\b/i, /\b\d+\s?mg\b(?!\s*\/)/i, /\btablet\b/i, /\bcapsule\b/i, /\binjection\b/i,
  /\b(start|begin|take)\s+(a\s+)?supplement/i, /\bstop taking\b/i, /\bmedication\b/i,
  /\bmetformin\b/i, /\bthyroxine\b/i, /\batorvastatin\b/i, /\bstatin\b/i, /\binsulin\b/i,
  // prognosis
  /\bwill develop\b/i, /\bwill lead to\b/i, /\bwill cause\b/i, /\brisk of death\b/i,
  /\blife-?threatening\b/i, /\bfatal\b/i,
  // false reassurance — as dangerous as false alarm
  /\bnothing to worry about\b/i, /\bno cause for concern\b/i, /\bperfectly healthy\b/i,
  /\byou are fine\b/i, /\bno need to see a doctor\b/i, /\bdoes not require attention\b/i,
];

/** Cyrillic / Arabic / Devanagari / CJK — used to catch a wrong-language reply. */
export const NON_LATIN = /[Ѐ-ӿ؀-ۿऀ-ॿ一-鿿]/;

export function findBanned(text: string): string[] {
  const hits: string[] = [];
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}

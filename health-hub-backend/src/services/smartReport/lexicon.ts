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
  // Unproven remedies. Now that the model may write its own advice when the
  // catalog has none, this is the only backstop on WHAT it may suggest — advice
  // quality is not otherwise machine-checkable. Papaya leaf leads the list on
  // purpose: it is the standard folk answer to low platelets in a dengue season,
  // which is exactly the fever-panel case that prompted allowing this at all.
  /\bpapaya\s*-?\s*leaf/i, /\bgiloy\b/i, /\btinospora\b/i, /\bcolloidal silver\b/i,
  /\bnoni\b/i, /\bwheatgrass\b/i, /\bapple cider vinegar\b/i, /\bmiracle\b/i,
  /\bhome remed/i, /\bnatural remed/i, /\bfolk remed/i, /\bdetox/i, /\bcleanse\b/i,
  /\bimmunity boost/i, /\bboosts? your immunity\b/i, /\bmegadose/i, /\bmega dose\b/i,
  /\bcures?\b/i, /\bwill heal\b/i, /\bhomeopath/i, /\bayurvedic (medicine|treatment)\b/i,
  /\bsiddha\b/i, /\bunani\b/i,
  /\bprescri/i, /\bdosage\b/i, /\b\d+\s?mg\b(?!\s*\/)/i, /\btablet\b/i, /\bcapsule\b/i, /\binjection\b/i,
  /\b(start|begin|take)\s+(a\s+)?supplement/i, /\bstop taking\b/i, /\bmedication\b/i,
  /\bmetformin\b/i, /\bthyroxine\b/i, /\batorvastatin\b/i, /\bstatin\b/i,
  // 'insulin' is also the NAME of a test we run, so ban it only where it reads as
  // a treatment. Explaining what fasting insulin measures is legitimate; telling a
  // patient to start, stop or adjust it is not.
  /\b(start|stop|begin|adjust|increase|decrease|take|inject|need|needs|require)\s+(\w+\s+){0,2}insulin\b/i,
  /\binsulin\s+(injection|therapy|dose|dosage|shot|pen|treatment)\b/i,
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

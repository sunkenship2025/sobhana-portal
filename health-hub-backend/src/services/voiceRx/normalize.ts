/**
 * Deterministic normalisation — the things a model should never be asked to do.
 *
 * Number words, dose abbreviations and timing phrases are FIXED MAPPINGS. Handing
 * them to an LLM buys nothing and costs the one thing we cannot afford: a chance
 * of a different answer next time. "Six twenty five" is 625 every time or the
 * system is not fit for medication.
 *
 * Everything here is pure and synchronously testable — see demo() at the bottom,
 * which is the runnable check for this file.
 */

// ---------------------------------------------------------------------------
// Number words, English + the Hindi/Urdu forms heard in Indian clinics
// ---------------------------------------------------------------------------

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  // Hindi — written as doctors say them, not as transliteration purists would.
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, panch: 5, paanch: 5, chhe: 6, che: 6, chah: 6,
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, barah: 12, terah: 13,
  chaudah: 14, chaudha: 14, chouda: 14, chawda: 14, pandrah: 15, pandra: 15, solah: 16,
  satrah: 17, atharah: 18, unnis: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  bees: 20, tees: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, saath: 60,
};

const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, sau: 100, hazaar: 1000 };

/**
 * Indian scripts -> English letters, by sound.
 *
 * The recogniser writes a medicine name in Devanagari, Telugu — once even Tamil or
 * Gurmukhi — when it hears it inside Hindi or Telugu speech: "कमबे फलम" for
 * Combiflam. The matcher reads Latin letters only, so such a name used to vanish.
 * This gives it "kambe phalam" to match by sound (a question, never a decision —
 * approximate matches always ask).
 *
 * One table serves every script: the Unicode blocks for Devanagari, Bengali,
 * Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada and Malayalam share the ISCII
 * layout, so a letter's offset inside its block means the same sound in all.
 * Rough on purpose — it only has to get a name close enough to be recognised.
 */
const INDIC_BLOCKS = [0x0900, 0x0980, 0x0a00, 0x0a80, 0x0b00, 0x0b80, 0x0c00, 0x0c80, 0x0d00];
// Long vowels come out single: brand names in English letters are never spelled
// with them doubled, and "paan" matched a paan-flavoured nicotine gum for Pan 40.
const INDIC_VOWELS: Record<number, string> = {
  0x05: 'a', 0x06: 'a', 0x07: 'i', 0x08: 'i', 0x09: 'u', 0x0a: 'u', 0x0b: 'ru', 0x0e: 'e', 0x0f: 'e',
  0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au',
};
const INDIC_CONSONANTS: Record<number, string> = {
  0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng', 0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j', 0x1d: 'jh', 0x1e: 'ny',
  0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n', 0x24: 't', 0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n',
  0x29: 'n', 0x2a: 'p', 0x2b: 'ph', 0x2c: 'b', 0x2d: 'bh', 0x2e: 'm', 0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l',
  0x33: 'l', 0x34: 'l', 0x35: 'v', 0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h',
  0x58: 'q', 0x59: 'kh', 0x5a: 'g', 0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
};
const INDIC_SIGNS: Record<number, string> = {
  0x3e: 'a', 0x3f: 'i', 0x40: 'i', 0x41: 'u', 0x42: 'u', 0x43: 'ru', 0x45: 'e', 0x46: 'e', 0x47: 'e', 0x48: 'ai',
  0x49: 'o', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au',
};
const NUKTA_SHIFT: Record<string, string> = { j: 'z', ph: 'f', k: 'q', g: 'g', d: 'r' };

export function transliterateIndic(input: string): string {
  if (!/[ऀ-ൿ]/.test(input)) return input;
  const off = (ch: string): number | null => {
    const c = ch.codePointAt(0)!;
    const base = INDIC_BLOCKS.find((b) => c >= b && c < b + 0x80);
    return base === undefined ? null : c - base;
  };
  const chars = [...input];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const o = off(chars[i]);
    if (o === null) { out += chars[i]; continue; }
    if (o >= 0x66 && o <= 0x6f) { out += String(o - 0x66); continue; }        // digits
    if (o === 0x01 || o === 0x02) { out += 'n'; continue; }                     // candrabindu, anusvara
    if (o === 0x03) { out += 'h'; continue; }                                    // visarga
    if (INDIC_VOWELS[o]) { out += INDIC_VOWELS[o]; continue; }
    let cons = INDIC_CONSONANTS[o];
    if (!cons) continue;                                                         // anything else: drop
    let j = i + 1;
    if (off(chars[j] ?? '') === 0x3c) { cons = NUKTA_SHIFT[cons] ?? cons; j++; } // nukta
    const next = off(chars[j] ?? '');
    if (next === 0x4d) { out += cons; i = j; continue; }                        // virama: no vowel
    if (next !== null && INDIC_SIGNS[next]) { out += cons + INDIC_SIGNS[next]; i = j; continue; }
    // Inherent 'a' — except at the end of a word, where Hindi drops it ("फलम" is
    // phalam, not phalama).
    const after = chars[j];
    const wordEnds = after === undefined || off(after) === null;
    out += wordEnds ? cons : cons + 'a';
    i = j - 1;
  }
  return out;
}

/**
 * Convert spoken number words inside a string to digits.
 *
 * The hard case is the one Indian doctors use constantly: "six twenty five" means
 * 625, not 6 and 25 and not 6*20+5. A strength is read DIGIT-GROUP-WISE, so when
 * a unit word is followed directly by a tens word we concatenate rather than add.
 * "six fifty" -> 650. "four twenty five" -> 425. But "twenty five" alone -> 25.
 */
export function wordsToNumbers(input: string): string {
  const tokens = input.split(/(\s+|[-,])/);
  const out: string[] = [];
  let i = 0;

  const isUnit = (w: string) => UNITS[w] !== undefined;
  const isTens = (w: string) => TENS[w] !== undefined;
  const isScale = (w: string) => SCALES[w] !== undefined;
  const word = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');

  while (i < tokens.length) {
    const raw = tokens[i];
    const w = word(raw);

    if (!w || (!isUnit(w) && !isTens(w) && !isScale(w))) {
      out.push(raw);
      i++;
      continue;
    }

    // Collect a run of number words, remembering which token index each came
    // from so a capped run can hand the rest back untouched.
    const run: string[] = [];
    const at: number[] = [];
    let j = i;
    while (j < tokens.length) {
      const ww = word(tokens[j]);
      if (!ww) {
        const nxt = tokens[j + 1] ? word(tokens[j + 1]) : '';
        if (nxt && (isUnit(nxt) || isTens(nxt) || isScale(nxt))) { j++; continue; }
        break;
      }
      if (isUnit(ww) || isTens(ww) || isScale(ww)) { run.push(ww); at.push(j); j++; continue; }
      break;
    }

    // A strength read digit-group-wise ("six twenty five" = 625) is at most
    // unit + tens + unit. Anything after that is a different clause —
    // "...six twenty five THREE times a day" must keep its three.
    let take = run.length;
    if (run.length > 1 && UNITS[run[0]] !== undefined && UNITS[run[0]] < 10 && TENS[run[1]] !== undefined) {
      take = run.length >= 3 && UNITS[run[2]] !== undefined && UNITS[run[2]] < 10 ? 3 : 2;
    } else {
      // Otherwise words combine only the way numbers are spoken: tens then a unit
      // ("twenty five", "bees paanch"), or around a scale ("two hundred fifty").
      // Two plain numbers side by side are two numbers — "ek teen din" is "1 3
      // din", three days, and used to be ADDED into four.
      for (let k = 1; k < run.length; k++) {
        const prev = run[k - 1], cur = run[k];
        const joins = (isTens(prev) && isUnit(cur) && UNITS[cur] < 10) || isScale(cur) || (isScale(prev) && (isUnit(cur) || isTens(cur)));
        if (!joins) { take = k; break; }
      }
    }

    out.push(String(evaluateRun(run.slice(0, take))));
    // Resume at the first token NOT consumed, so the remainder is re-scanned
    // rather than dropped. The separators between were skipped while scanning,
    // so put one back — without it "six twenty five three" joins as "6253".
    if (take < run.length) {
      out.push(' ');
      i = at[take];
    } else {
      i = j;
    }
  }

  return out.join('').replace(/\s+/g, ' ').trim();
}

function evaluateRun(run: string[]): number | string {
  if (run.length === 0) return '';
  if (run.length === 1) {
    const w = run[0];
    return UNITS[w] ?? TENS[w] ?? SCALES[w] ?? w;
  }

  // "six twenty five" / "six fifty" — digit-group reading of a strength.
  // A leading UNIT followed by a TENS is concatenation, not addition.
  if (UNITS[run[0]] !== undefined && UNITS[run[0]] < 10 && TENS[run[1]] !== undefined) {
    const head = UNITS[run[0]];
    const tens = TENS[run[1]];
    const trailing = run[2] !== undefined && UNITS[run[2]] !== undefined && UNITS[run[2]] < 10 ? UNITS[run[2]] : 0;
    return Number(`${head}${tens + trailing}`);
  }

  // Otherwise the ordinary additive/multiplicative reading.
  let total = 0;
  let current = 0;
  for (const w of run) {
    if (UNITS[w] !== undefined) current += UNITS[w];
    else if (TENS[w] !== undefined) current += TENS[w];
    else if (SCALES[w] !== undefined) {
      const s = SCALES[w];
      current = (current || 1) * s;
      if (s >= 1000) { total += current; current = 0; }
    }
  }
  return total + current;
}

// ---------------------------------------------------------------------------
// Frequency
// ---------------------------------------------------------------------------

export type FrequencyCode =
  | 'OD' | 'BD' | 'TID' | 'QID' | 'HS' | 'SOS' | 'STAT' | 'WEEKLY' | 'ALT_DAY' | 'QH';

/** Canonical printed wording for each code. One source of truth for the sheet. */
export const FREQUENCY_TEXT: Record<FrequencyCode, string> = {
  OD: 'once daily',
  BD: 'twice daily',
  TID: 'three times a day',
  QID: 'four times a day',
  HS: 'at bedtime',
  SOS: 'as needed',
  STAT: 'immediately, single dose',
  WEEKLY: 'once weekly',
  ALT_DAY: 'every other day',
  QH: 'hourly',
};

const FREQ_PATTERNS: [RegExp, FrequencyCode][] = [
  [/\b(od|o\.d\.|once\s*(a\s*)?day|once\s*daily|din\s*me\s*ek\s*(baar|bar)|ek\s*baar)\b/i, 'OD'],
  [/\b(bd|b\.d\.|bid|twice\s*(a\s*)?day|twice\s*daily|din\s*me\s*do\s*(baar|bar)|do\s*baar|subah\s*shaam|subah\s*sham)\b/i, 'BD'],
  [/\b(tid|t\.i\.d\.|tds|thrice\s*(a\s*)?day|three\s*times?\s*(a\s*)?day|teen\s*(baar|bar))\b/i, 'TID'],
  [/\b(qid|q\.i\.d\.|qds|four\s*times?\s*(a\s*)?day|char\s*(baar|bar)|chaar\s*(baar|bar))\b/i, 'QID'],
  [/\b(hs|at\s*(bed\s*)?time|bed\s*time|bedtime|raat\s*ko|sone\s*se\s*pehle)\b/i, 'HS'],
  [/\b(sos|s\.o\.s\.|as\s*needed|if\s*(required|needed)|prn|zaroorat\s*pa?d?ne?\s*par|jarurat)\b/i, 'SOS'],
  [/\b(stat|immediately|abhi|turant)\b/i, 'STAT'],
  [/\b(weekly|once\s*a\s*week|hafte\s*me\s*ek)\b/i, 'WEEKLY'],
  [/\b(alternate\s*day|every\s*other\s*day|alt\s*day|ek\s*din\s*chhod)\b/i, 'ALT_DAY'],
  [/\b(hourly|every\s*hour)\b/i, 'QH'],
];

export function parseFrequency(text: string): FrequencyCode | null {
  if (!text) return null;
  for (const [re, code] of FREQ_PATTERNS) if (re.test(text)) return code;
  // "1-0-1" / "1-1-1" — the dosing grid every Indian prescription pad uses.
  const grid = text.match(/\b([0-2])\s*[-–]\s*([0-2])\s*[-–]\s*([0-2])\b/);
  if (grid) {
    const n = [grid[1], grid[2], grid[3]].filter((x) => Number(x) > 0).length;
    if (n === 1) return 'OD';
    if (n === 2) return 'BD';
    if (n === 3) return 'TID';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Timing / route / duration
// ---------------------------------------------------------------------------

export type Timing = 'before food' | 'after food' | 'with food' | 'empty stomach' | 'bedtime';

const TIMING_PATTERNS: [RegExp, Timing][] = [
  [/\b(before\s*(food|meals?|breakfast)|khane\s*se\s*pehle|bhojan\s*se\s*pehle)\b/i, 'before food'],
  [/\b(after\s*(food|meals?)|khane\s*ke\s*baad|bhojan\s*ke\s*baad|pc\b)\b/i, 'after food'],
  [/\b(with\s*(food|meals?)|khane\s*ke\s*saath)\b/i, 'with food'],
  [/\b(empty\s*stomach|khali\s*pet|nil\s*by\s*mouth)\b/i, 'empty stomach'],
  [/\b(at\s*bed\s*time|bedtime|raat\s*ko\s*sone)\b/i, 'bedtime'],
];

export function parseTiming(text: string): Timing | null {
  if (!text) return null;
  for (const [re, t] of TIMING_PATTERNS) if (re.test(text)) return t;
  return null;
}

const ROUTE_PATTERNS: [RegExp, string][] = [
  [/\b(oral|by\s*mouth|po\b|khana|mooh)\b/i, 'oral'],
  [/\b(iv|intravenous|nas\s*me)\b/i, 'IV'],
  [/\b(im|intramuscular)\b/i, 'IM'],
  [/\b(sc|subcutaneous)\b/i, 'SC'],
  [/\b(topical|apply|lagana|lagaye)\b/i, 'topical'],
  [/\b(eye\s*drops?|ocular)\b/i, 'ophthalmic'],
  [/\b(ear\s*drops?|otic)\b/i, 'otic'],
  [/\b(nasal|nose\s*drops?)\b/i, 'nasal'],
  [/\b(inhal|puff|nebuli)\w*/i, 'inhalation'],
  [/\b(pv|vaginal)\b/i, 'vaginal'],
  [/\b(pr|rectal)\b/i, 'rectal'],
];

export function parseRoute(text: string): string | null {
  if (!text) return null;
  for (const [re, r] of ROUTE_PATTERNS) if (re.test(text)) return r;
  return null;
}

export interface Duration { value: number; unit: 'days' | 'weeks' | 'months' }

export function parseDuration(text: string): Duration | null {
  if (!text) return null;
  const t = wordsToNumbers(text.toLowerCase());
  // `din me(in)` means "per day" — a frequency phrase. Without this negative
  // lookahead "650 din me do baar" reads as a 650-day course.
  const m = t.match(/\b(\d+)\s*(day|days|din|week|weeks|hafta|hafte|month|months|mahina|mahine)\b(?!\s*(me|mein)\b)/);
  if (!m) return null;
  const value = Number(m[1]);
  const u = m[2];
  const unit: Duration['unit'] = /week|hafta|hafte/.test(u) ? 'weeks' : /month|mahina|mahine/.test(u) ? 'months' : 'days';
  return { value, unit };
}

/** "500 mg", "625", "10ml" -> { strength, unit } */
export function parseStrength(text: string, opts: { requireUnit?: boolean } = {}): { strength: string; unit: string | null } | null {
  if (!text) return null;
  const t = wordsToNumbers(text.toLowerCase());
  // requireUnit: for a whole clause rather than the drug token. A bare number
  // there is a count, a frequency or a duration as often as a strength — "two
  // times a day" made strength 2, and 2 matched a 2% gel. Only a strength unit
  // (not ml, which is a dose of a syrup) makes a number a strength there.
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?)\s*(mg|mcg|gm|g|ml|iu|units?|%)?(?![a-z0-9])/g)) {
    const unit = m[2] === 'gm' ? 'g' : m[2] ?? null;
    if (opts.requireUnit && !(unit && /^(mg|mcg|g|iu|%)$/.test(unit))) continue;
    if (!unit) {
      // The model's spokenText is often the whole phrase: "Pantop DSR for 7 days",
      // "Steam inhalation 3-4 times a day". A number after for/after/every is a
      // duration; one before "times" a count. (Not "N din": "Pan 40 din me ek
      // baar" is Pan 40, once a day.)
      if (/\b(for|after|every|since|within|next|till|until|upto)$/.test(t.slice(0, m.index).trimEnd())) continue;
      if (/^\s*(?:(?:-|to)\s*\d+\s*)?times?\b/.test(t.slice(m.index! + m[0].length))) continue;
    }
    return { strength: m[1].replace(/\s+/g, ''), unit };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runnable self-check — `npx tsx src/services/voiceRx/normalize.ts`
// ---------------------------------------------------------------------------

export function demo(): void {
  const eq = (got: unknown, want: unknown, label: string) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) throw new Error(`${label}: got ${g}, want ${w}`);
  };

  // The digit-group reading that a naive parser gets wrong.
  eq(wordsToNumbers('augmentin six twenty five'), 'augmentin 625', 'six twenty five');
  eq(wordsToNumbers('paracetamol six fifty'), 'paracetamol 650', 'six fifty');
  eq(wordsToNumbers('pantop forty'), 'pantop 40', 'forty');
  eq(wordsToNumbers('amlodipine five'), 'amlodipine 5', 'five');
  eq(wordsToNumbers('azithromycin five hundred'), 'azithromycin 500', 'five hundred');
  eq(wordsToNumbers('four twenty five'), '425', 'four twenty five');
  eq(wordsToNumbers('twenty five'), '25', 'bare twenty five');
  eq(wordsToNumbers('ek teen din'), '1 3 din', 'two plain numbers are two numbers, never a sum');
  eq(wordsToNumbers('subah ek teen din'), 'subah 1 3 din', '…inside a sentence too');
  eq(wordsToNumbers('two hundred fifty'), '250', 'a scale still joins');
  eq(wordsToNumbers('chawda din'), '14 din', 'Hindi fourteen');
  eq(parseStrength('Two times in a day, please have an antibiotic named Azithromycin', { requireUnit: true }), null, 'a count is not a strength');
  eq(parseStrength('Dolo 650 mg twice a day for 5 days', { requireUnit: true }), { strength: '650', unit: 'mg' }, 'a strength with its unit is');
  eq(parseStrength('10 ml in the morning', { requireUnit: true }), null, 'a syrup dose is not a strength');
  eq(parseStrength('Augmentin 625'), { strength: '625', unit: null }, 'inside the drug token, a bare number is');
  eq(parseStrength('Pantop DSR for 7 days'), null, 'a duration is not a strength');
  eq(parseStrength('Steam inhalation 3-4 times a day'), null, 'a count is not a strength');
  eq(parseStrength('Pan 40 din me ek baar'), { strength: '40', unit: null }, '"N din" after a name is still its strength');
  eq(parseStrength('Dolo 650 tablet thrice a day for 6 days'), { strength: '650', unit: null }, 'the strength, not the duration');
  eq(parseStrength('Thyroxine 25 MCG for 15 days'), { strength: '25', unit: 'mcg' }, 'a unit strength');
  eq(parseStrength('30 gm gel'), { strength: '30', unit: 'g' }, 'gm is grams');
  eq(parseStrength('Rabiz-D 30 x 20 mg capsule')?.strength, '30', '"30 x 20" is a combination strength, not a count');
  eq(transliterateIndic('कमबे फलम'), 'kamabe phalam', 'Devanagari brand, by sound');
  eq(transliterateIndic('ఆగ్మెంటిన్ 625'), 'agmentin 625', 'Telugu brand, virama and anusvara');
  eq(transliterateIndic('Augmentin 625'), 'Augmentin 625', 'Latin is left alone');
  eq(transliterateIndic('पान 40'), 'pan 40', 'Pan, in Devanagari');
  eq(wordsToNumbers('teen din'), '3 din', 'hindi teen');

  eq(parseFrequency('BD five days'), 'BD', 'BD');
  eq(parseFrequency('three times a day'), 'TID', 'TID');
  eq(parseFrequency('din me do baar'), 'BD', 'hinglish BD');
  eq(parseFrequency('1-0-1'), 'BD', 'grid 1-0-1');
  eq(parseFrequency('1-1-1'), 'TID', 'grid 1-1-1');
  eq(parseFrequency('SOS'), 'SOS', 'SOS');
  eq(parseFrequency('nothing here'), null, 'no frequency');

  eq(parseTiming('after food'), 'after food', 'after food');
  eq(parseTiming('khane ke baad'), 'after food', 'hinglish after food');
  eq(parseTiming('once daily'), null, 'timing must NOT be invented from frequency');

  eq(parseDuration('for five days'), { value: 5, unit: 'days' }, 'five days');
  eq(parseDuration('teen din'), { value: 3, unit: 'days' }, 'hindi duration');
  eq(parseDuration('two weeks'), { value: 2, unit: 'weeks' }, 'weeks');

  eq(parseStrength('six twenty five'), { strength: '625', unit: null }, 'strength words');
  eq(parseStrength('500 mg'), { strength: '500', unit: 'mg' }, 'strength digits');

  eq(parseRoute('apply locally'), 'topical', 'route topical');

  // --- REGRESSIONS. Every one of these was a real defect found by running the
  // --- pipeline against the live catalogue, not a hypothetical.
  //
  // 1. A digit-group run swallowed the word after it: "six twenty five three
  //    times a day" collapsed to 625 AND ate the "three", losing the frequency.
  eq(wordsToNumbers('Augmentin six twenty five three times a day'),
     'Augmentin 625 3 times a day', 'regression: run must not eat the next word');
  eq(parseFrequency('Augmentin six twenty five three times a day'), 'TID',
     'regression: frequency survives a digit-group strength');
  // 2. Capping the run dropped the separator, joining "625" and "3" into "6253".
  eq(wordsToNumbers('six twenty five three'), '625 3', 'regression: separator kept when a run is capped');
  // 3. "din me" is "per day" — a FREQUENCY. It was being read as a duration, so
  //    "dolo 650 din me do baar" prescribed a 650-DAY course.
  eq(parseDuration('dolo 650 din me do baar khane ke baad teen din'),
     { value: 3, unit: 'days' }, 'regression: "din me" is not a duration');
  eq(parseFrequency('dolo 650 din me do baar'), 'BD', 'regression: din me do baar is BD');
  // 4. The rule the whole feature turns on: a frequency is never invented from
  //    a timing. "Pantop forty before breakfast" states WHEN, not HOW OFTEN.
  eq(parseFrequency('Pantop forty before breakfast'), null,
     'regression: timing must not imply a frequency');
  eq(parseTiming('Pantop forty before breakfast'), 'before food', 'regression: timing still parsed');

  // eslint-disable-next-line no-console
  console.log('normalize.ts: all checks passed');
}

if (require.main === module) demo();

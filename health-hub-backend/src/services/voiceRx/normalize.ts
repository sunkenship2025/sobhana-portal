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
  saat: 7, aath: 8, nau: 9, das: 10, dus: 10, gyarah: 11, barah: 12, pandrah: 15,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
  bees: 20, tees: 30, chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, saath: 60,
};

const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, sau: 100, hazaar: 1000 };

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
export function parseStrength(text: string): { strength: string; unit: string | null } | null {
  if (!text) return null;
  const t = wordsToNumbers(text.toLowerCase());
  const m = t.match(/\b(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?)\s*(mg|mcg|g|ml|iu|units?|%)?\b/);
  if (!m) return null;
  return { strength: m[1].replace(/\s+/g, ''), unit: m[2] ?? null };
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

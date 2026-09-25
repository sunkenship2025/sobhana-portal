/**
 * Transcript -> structured draft.
 *
 * WHAT THE MODEL IS AND IS NOT ASKED TO DO
 * It segments a transcript and reports what was SAID. It does not decide what a
 * drug is (resolver.ts does), it does not decide whether a prescription is safe
 * (validator.ts does), and it is never the source of truth for anything that
 * reaches the sheet. That is why a cheap non-reasoning model is sufficient — and
 * why a reasoning model is actively wrong here: reasoning is inference, and
 * inference is invention. A thinking model handed "Pantop 40 once daily" will
 * reason its way to "before breakfast", which is precisely the forbidden move.
 *
 * PROMPT CACHING
 * The static half (instructions + vocabulary + examples) is emitted FIRST and the
 * transcript LAST, because DeepSeek charges ~50x less for cached input. Reordering
 * these two halves is not cosmetic; it is most of the bill.
 */
import { logger } from '../../lib/logger';
import { medicineVocabulary } from './resolver';
import {
  parseFrequency, parseTiming, parseRoute, parseDuration, parseStrength,
  wordsToNumbers, FREQUENCY_TEXT, type FrequencyCode,
} from './normalize';

const BASE_URL = (
  process.env.VOICE_RX_LLM_BASE_URL
  || process.env.SMART_REPORT_LLM_BASE_URL
  || 'https://api.deepseek.com'
).replace(/\/+$/, '');

const API_KEY =
  process.env.VOICE_RX_LLM_API_KEY
  || process.env.SMART_REPORT_LLM_API_KEY
  || process.env.SARVAM_API_KEY
  || '';

const MODEL = process.env.VOICE_RX_LLM_MODEL || 'deepseek-chat';
const TIMEOUT_MS = Number(process.env.VOICE_RX_LLM_TIMEOUT_MS || 45_000);

export class ExtractionUnavailable extends Error {}

/** Where a value came from. The distinction PART 6 of the brief turns on. */
export type FieldState = 'SPOKEN' | 'NORMALIZED' | 'UNKNOWN';

export interface ExtractedItem {
  spokenText: string;
  name: string;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  doseQty: string | null;
  doseUnit: string | null;
  frequencyCode: FrequencyCode | null;
  frequencyText: string | null;
  route: string | null;
  timing: string | null;
  durationValue: number | null;
  durationUnit: string | null;
  instructions: string | null;
  fieldStates: Record<string, FieldState>;
  sourceText: string | null;
  sourceStart: number | null;
  sourceEnd: number | null;
  /**
   * True when the doctor offered this as one of several OPTIONS rather than
   * prescribing it. "Either azithromycin or amoxiclav" must never become two
   * prescribed medicines — the single failure class adversarial reviewers caught
   * least often (4.5%) in a 565-note audit of deployed commercial scribes.
   */
  isAlternative: boolean;
}

export interface ExtractionResult {
  items: ExtractedItem[];
  diagnosis: string | null;
  notes: string | null;
  followUpDays: number | null;
  /** Things the doctor plausibly meant to say but did not. Surfaced, not inferred. */
  missing: string[];
  model: string;
  rawJson: unknown;
}

// ---------------------------------------------------------------------------
// Prompt — STATIC HALF. Keep this stable; every edit invalidates the cache.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You convert a doctor's dictated prescription into structured JSON.

You are a TRANSCRIPTION STRUCTURER, not a clinician. You never decide what is
medically correct, and you never add information the doctor did not say.

ABSOLUTE RULES
1. NEVER invent a field. If the doctor did not say a timing, dose, route or
   duration, that field is null. Do not supply a "usual" value. "Pantop 40 once
   daily" has NO timing — do not write "before breakfast".
2. Report medicine names EXACTLY as heard, in "spokenText". Do not correct its
   spelling, do not expand a brand into a generic. "name" is the medicine token
   as heard too — EXCEPT a clear mishearing, under MISHEARD NAMES below. A
   separate system resolves names against a catalogue.
3. If the doctor offers a CHOICE ("either X or Y", "X or else Y", "start with X"),
   mark every option with "isAlternative": true. Never emit a choice as two
   separate prescribed medicines.
4. If the doctor corrects themselves ("no, make that 500"), keep only the
   corrected value.
5. Output ONLY JSON. No prose, no markdown fence.

FIELD PROVENANCE
For each medicine include "fieldStates" marking every field as one of:
  "SPOKEN"     - the doctor said it
  "NORMALIZED" - you rewrote what was said into a standard form (e.g. "teen baar"
                 -> frequency TID). The MEANING must be exactly what was said.
  "UNKNOWN"    - not said. The field itself must be null.

LANGUAGE
The dictation is Indian English, Hindi, Telugu, or a mix of them. Treat Hindi
and Telugu words as equal to English: "din me do baar" is a frequency, "khane ke
baad" is a timing, "teen din" is a duration. Number words may be spoken
digit-group-wise: "six twenty five" means 625, "six fifty" means 650.

The speech recogniser often writes TELUGU in the wrong script or a rough
spelling — Telugu script, Devanagari, or Latin letters ("rojuki moodu saarlu",
"रोजु की मूडु सालू", "Rojuki Nalugu Salu" are all the same words). Read them by
SOUND. Telugu, by sound:
  rojuki okasari / okkasari        once a day (OD)
  rojuki rendu saarlu              twice a day (BD)
  moodu saarlu                     three times a day (TID)
  nalugu saarlu                    four times a day (QID)
  udayam / poddhuna                morning      raatri / rathri   night
  padukune mundu                   at bedtime (timing "bedtime")
  bhojananiki mundu / annam mundu  before food  bhojanam tarvata  after food
  khaali kadupu(to)                empty stomach
  ... vachinappudu matrame / ... aite matrame / ... unte matrame / avasaram aite
                                   only when / only if / if there is / if needed
                                   -> SOS, with the condition in "instructions"
                                   ("for fever", "for pain")
  noppi = pain · jvaram = fever · vaantulu = vomiting · daggu = cough
  N rojulu = N days · vaaram / vaaram rojulu = 1 week · vaaralu = weeks ·
  nela / nelalu = month(s) · okka nela / oka nela / vokanila = 1 month
  Numbers — the recogniser spells them many ways; read by sound:
    okati / vokati / okkati 1 · rendu / rendhu 2 · moodu / mudu / muudu 3 ·
    nalugu / naalugu 4 · aidu / aidhu / ayidu / aedu / aayedu / आइदु / आयेदु 5 ·
    aaru / aru 6 · edu / yedu / eedu / एडु 7 · enimidi / enmidi 8 · tommidi 9 ·
    padi / padhi 10 · padihenu / padi henu 15 · iravai / iruvai 20 ·
    muppai / muppay 30 · nalabhai 40 · yabhai 50
  FIVE (aidu — an a- / ai- sound) and SEVEN (edu — an e- / ye- sound) are the
  dangerous pair. Spellings that START with a / aa / ai / ay ("aedu", "aayedu",
  "ayedu", "aidu") are FIVE — that is not ambiguous. Only e- / ye- ("edu",
  "yedu", "eedu") is seven. If the sound really cannot be told, leave it null —
  the doctor is asked. Never guess a number.
  "rojuki 4.00" / "rojuki 4" = four a day: the recogniser formats a spoken number
  as a time.
  kaadu, kaadu = "no, no" — a self-correction (rule 4)
Hindi, by sound: din me ek / do / teen / char baar = OD / BD / TID / QID ·
  subah = morning · raat ko = night · sone se pehle = bedtime · khane se pehle /
  baad = before / after food · khaali pet = empty stomach · ... ho to hi / ho tabhi
  / zaroorat pade to = only if -> SOS · hafta = week · mahina = month ·
  numbers ek 1 · do 2 · teen 3 · char 4 · paanch 5 · chhe 6 · saat 7 · aath 8 ·
  nau 9 · das 10 · chaudah / chawda 14 · pandrah 15 · bees 20 · tees 30.
  "saath din" / "साथ दिन" is saat din, 7 days. Two number words side by side are two
  numbers ("ek, teen din" is one tablet, three days) — never add them.
  X gaani Y gaani = "either X or Y" — a choice (rule 3)
MEDICINE NAMES are said in English even inside Telugu speech. Give "name" in
Latin letters as it sounds — never in Telugu or Devanagari script ("ఆగ్మెంటిన్"
-> "Augmentin"); "spokenText" keeps exactly what was heard. Telugu words for a
tablet, syrup or medicine in general (tablet, goli, mandu, maatra) are NOT
names, and no ordinary Telugu or Hindi word is ever a medicine — "vaantulu",
"matrame", "okati"; "vivaran" (description), "dawai", "goli", "bimari". A
brand REPAIR needs a word that sounds like a medicine and sits where a medicine
is named — never an everyday word that happens to rhyme with one. If no medicine was mentioned at all, there is no medicine line — but
if a medicine was clearly SAID and its name came out garbled, KEEP the line with
the name as heard (in "spokenText" and "name"): the doctor sees it and fixes it.
A dropped line is a medicine silently missing from the prescription.
A number that belongs to a duration or a count ("five days", "okati") is never a
strength.

MISHEARD NAMES
The speech recogniser mangles medicine names, worst inside Telugu or Hindi
speech: "Set Scene 10" for Cetzine 10, "On them 4" for Ondem 4, "Calpal" for
Calpol, "Crossin" for Crocin, "$650" / "dollar 650" for Dolo 650, "Pan Top 40"
for Pantop 40, "Zinkawet" for Zincovit, "Azithril" for Azithral. When a heard
name is CLEARLY a mishearing of a real medicine — one on the clinic's list, or
a well-known Indian brand — because it SOUNDS like it and the sentence fits it
(an antiemetic "only if vomiting", an antipyretic "only if fever"):
  - put the real medicine in "name" ("Cetzine"), strength as said;
  - keep exactly what was heard in "spokenText" ("Set Scene 10");
  - set fieldStates.name to "NORMALIZED".
Two ways brands are misheard, all the time:
  - letters said after a brand run together or into it: "Rosuvas F" as
    "Rosuvaseff", "Pan D S R" as "Pandi SR", "Zerodol S P" as "Zerodol Esp";
  - vowels inside a brand come out wrong: "Amlong" as "Amlang", "Telmikind" as
    "Telmakind". Match by the consonants and the rhythm, not the vowels;
  - a brand arrives in Devanagari or Telugu script, often split in two words:
    "रोज़ु वास" (Rosuvas), "ఆమ్ లాంగ్" (Amlong). Join the pieces and read
    them by sound — a medicine said in the middle of Hindi or Telugu is still a
    medicine line.
Never "repair" one real medicine into another (Amlodipine is never changed to
Amiodarone; a name that is already a real medicine stays). If two medicines fit
equally, or none clearly does, leave the name as heard and fieldStates.name
"SPOKEN". A repaired name is always shown to the doctor to confirm.

OUTPUT SHAPE
{
  "items": [{
    "spokenText": "string - verbatim as heard",
    "name": "string - the medicine token only, no strength",
    "strength": "string|null", "strengthUnit": "string|null",
    "dosageForm": "tablet|capsule|syrup|injection|drops|ointment|inhaler|null",
    "doseQty": "string|null", "doseUnit": "string|null",
    "frequencyCode": "OD|BD|TID|QID|HS|SOS|STAT|WEEKLY|ALT_DAY|QH|null",
    "route": "oral|topical|IV|IM|SC|ophthalmic|otic|nasal|inhalation|null",
    "timing": "before food|after food|with food|empty stomach|bedtime|null",
    "durationValue": number|null, "durationUnit": "days|weeks|months|null",
    "instructions": "string|null",
    "isAlternative": boolean,
    "sourceText": "string - the clause this came from",
    "fieldStates": { "name":"SPOKEN", "strength":"SPOKEN|UNKNOWN", "doseQty":"...",
                     "frequency":"...", "route":"...", "timing":"...", "duration":"..." }
  }],
  "diagnosis": "string|null",
  "notes": "string|null",
  "followUpDays": number|null,
  "missing": ["short phrases naming what was expected but not said"]
}

EXAMPLES

Input: "Augmentin six twenty five three times a day after food for five days"
Output: {"items":[{"spokenText":"Augmentin six twenty five","name":"Augmentin",
"strength":"625","strengthUnit":null,"dosageForm":null,"doseQty":null,"doseUnit":null,
"frequencyCode":"TID","route":null,"timing":"after food","durationValue":5,
"durationUnit":"days","instructions":null,"isAlternative":false,
"sourceText":"Augmentin six twenty five three times a day after food for five days",
"fieldStates":{"name":"SPOKEN","strength":"SPOKEN","doseQty":"UNKNOWN","frequency":"NORMALIZED",
"route":"UNKNOWN","timing":"SPOKEN","duration":"SPOKEN"}}],
"diagnosis":null,"notes":null,"followUpDays":null,
"missing":["dose quantity not stated","route not stated"]}

Input: "patient ko azithromycin 500 BD five days dena hai"
Output: {"items":[{"spokenText":"azithromycin 500","name":"azithromycin",
"strength":"500","strengthUnit":null,"dosageForm":null,"doseQty":null,"doseUnit":null,
"frequencyCode":"BD","route":null,"timing":null,"durationValue":5,"durationUnit":"days",
"instructions":null,"isAlternative":false,
"sourceText":"patient ko azithromycin 500 BD five days dena hai",
"fieldStates":{"name":"SPOKEN","strength":"SPOKEN","doseQty":"UNKNOWN","frequency":"SPOKEN",
"route":"UNKNOWN","timing":"UNKNOWN","duration":"SPOKEN"}}],
"diagnosis":null,"notes":null,"followUpDays":null,
"missing":["timing not stated","dose quantity not stated"]}

Input: "give her either azithromycin or amoxiclav, let's start with the azithro 500 OD three days"
Output: {"items":[{"spokenText":"azithromycin","name":"azithromycin","strength":"500",
"strengthUnit":null,"dosageForm":null,"doseQty":null,"doseUnit":null,"frequencyCode":"OD",
"route":null,"timing":null,"durationValue":3,"durationUnit":"days","instructions":null,
"isAlternative":true,"sourceText":"either azithromycin or amoxiclav, let's start with the azithro 500 OD three days",
"fieldStates":{"name":"SPOKEN","strength":"SPOKEN","doseQty":"UNKNOWN","frequency":"SPOKEN",
"route":"UNKNOWN","timing":"UNKNOWN","duration":"SPOKEN"}},
{"spokenText":"amoxiclav","name":"amoxiclav","strength":null,"strengthUnit":null,
"dosageForm":null,"doseQty":null,"doseUnit":null,"frequencyCode":null,"route":null,
"timing":null,"durationValue":null,"durationUnit":null,"instructions":null,
"isAlternative":true,"sourceText":"either azithromycin or amoxiclav",
"fieldStates":{"name":"SPOKEN","strength":"UNKNOWN","doseQty":"UNKNOWN","frequency":"UNKNOWN",
"route":"UNKNOWN","timing":"UNKNOWN","duration":"UNKNOWN"}}],
"diagnosis":null,"notes":null,"followUpDays":null,
"missing":["the doctor offered a choice between two medicines - confirm which one is prescribed"]}`;

// ---------------------------------------------------------------------------

interface ChatResult { content: string; inputTokens: number | null; outputTokens: number | null }

async function chat(messages: { role: string; content: string }[]): Promise<ChatResult> {
  if (!API_KEY) throw new ExtractionUnavailable('No extraction API key configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      // temperature 0: extraction must be repeatable. A sampled extraction is a
      // different prescription on a retry, which is not a property medicine can have.
      body: JSON.stringify({ model: MODEL, messages, temperature: 0, response_format: { type: 'json_object' } }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new ExtractionUnavailable(`${res.status} ${body.slice(0, 300)}`);
    const json = JSON.parse(body);
    return {
      content: json?.choices?.[0]?.message?.content ?? '',
      inputTokens: json?.usage?.prompt_tokens ?? null,
      outputTokens: json?.usage?.completion_tokens ?? null,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new ExtractionUnavailable(`Timed out after ${TIMEOUT_MS}ms`);
    if (err instanceof ExtractionUnavailable) throw err;
    throw new ExtractionUnavailable(err?.message || 'Extraction request failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Models fence JSON even when told not to. Recover rather than fail the doctor. */
function parseLoose(raw: string): any {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ }
  }
  throw new ExtractionUnavailable('Model did not return parseable JSON');
}

/**
 * Attach a timestamp range by finding the item's source clause in the segments.
 *
 * Deliberately conservative: if the clause cannot be located, timings stay NULL
 * rather than being guessed. A source link that points at the wrong seconds is
 * worse than none, because the whole value of "view source" is that a doctor can
 * trust what it shows — and in production generative systems only ~74.5% of
 * citations actually support the claim attached to them.
 */
function locate(
  sourceText: string | null,
  segments: { text: string; start: number; end: number }[],
): { start: number | null; end: number | null } {
  if (!sourceText || segments.length === 0) return { start: null, end: null };
  const needle = sourceText.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!needle) return { start: null, end: null };
  const words = needle.split(' ').filter((w) => w.length > 2);
  if (words.length === 0) return { start: null, end: null };

  let best: { start: number; end: number; hits: number } | null = null;
  for (const seg of segments) {
    const hay = seg.text.toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { start: seg.start, end: seg.end, hits };
  }
  // Require at least a third of the distinctive words to land in one segment.
  if (!best || best.hits < Math.max(1, Math.ceil(words.length / 3))) return { start: null, end: null };
  return { start: best.start, end: best.end };
}

/**
 * Deterministic backstop over the model's output.
 *
 * Anything a regex can decide, a regex decides — and it OVERRIDES the model,
 * because a fixed mapping cannot drift between runs and a model can. The model's
 * value is segmentation; ours is that "six twenty five" is 625 every single time.
 */
function reconcile(item: any, fullText: string): ExtractedItem {
  const spoken = String(item?.spokenText ?? '').trim();
  const source = item?.sourceText ? String(item.sourceText) : spoken || null;
  const scope = source || fullText;

  const states: Record<string, FieldState> = {
    name: 'SPOKEN', strength: 'UNKNOWN', doseQty: 'UNKNOWN',
    frequency: 'UNKNOWN', route: 'UNKNOWN', timing: 'UNKNOWN', duration: 'UNKNOWN',
    ...(item?.fieldStates ?? {}),
  };

  // Strength: prefer ours off the spoken text, since number words are our job.
  let strength: string | null = item?.strength ? String(item.strength) : null;
  let strengthUnit: string | null = item?.strengthUnit ? String(item.strengthUnit) : null;
  // The drug token as heard ("Augmentin 625") may carry a bare strength; the rest
  // of the clause only a number with a strength unit — see parseStrength.
  const ps = parseStrength(spoken) ?? parseStrength(scope, { requireUnit: true });
  if (ps) {
    strength = ps.strength;
    strengthUnit = strengthUnit ?? ps.unit;
    states.strength = 'SPOKEN';
  } else if (!strength) {
    states.strength = 'UNKNOWN';
  }

  const freqFromText = parseFrequency(scope);
  const frequencyCode: FrequencyCode | null =
    freqFromText ?? (item?.frequencyCode && FREQUENCY_TEXT[item.frequencyCode as FrequencyCode]
      ? (item.frequencyCode as FrequencyCode)
      : null);
  if (frequencyCode) states.frequency = states.frequency === 'UNKNOWN' ? 'NORMALIZED' : states.frequency;
  else states.frequency = 'UNKNOWN';

  const timing = parseTiming(scope) ?? (item?.timing ? String(item.timing) : null);
  states.timing = timing ? (states.timing === 'UNKNOWN' ? 'SPOKEN' : states.timing) : 'UNKNOWN';

  const route = parseRoute(scope) ?? (item?.route ? String(item.route) : null);
  states.route = route ? (states.route === 'UNKNOWN' ? 'NORMALIZED' : states.route) : 'UNKNOWN';

  const dur = parseDuration(scope);
  const durationValue = dur?.value ?? (item?.durationValue != null ? Number(item.durationValue) : null);
  const durationUnit = dur?.unit ?? (item?.durationUnit ? String(item.durationUnit) : null);
  states.duration = durationValue != null ? 'SPOKEN' : 'UNKNOWN';

  const doseQty = item?.doseQty != null ? String(item.doseQty) : null;
  states.doseQty = doseQty ? states.doseQty : 'UNKNOWN';

  // The medicine token, stripped of a trailing strength the model left attached.
  let name = String(item?.name ?? spoken).trim();
  name = wordsToNumbers(name);
  if (strength) {
    name = name.replace(new RegExp(`\\s*\\b${strength.replace(/[+]/g, '\\+')}\\b\\s*(mg|mcg|ml|g|iu)?$`, 'i'), '').trim();
  }

  return {
    spokenText: spoken || name,
    name: name || spoken,
    strength, strengthUnit,
    dosageForm: item?.dosageForm ? String(item.dosageForm) : null,
    doseQty,
    doseUnit: item?.doseUnit ? String(item.doseUnit) : null,
    frequencyCode,
    frequencyText: frequencyCode ? FREQUENCY_TEXT[frequencyCode] : null,
    route, timing,
    durationValue, durationUnit,
    instructions: item?.instructions ? String(item.instructions) : null,
    fieldStates: states,
    sourceText: source,
    sourceStart: null,
    sourceEnd: null,
    isAlternative: !!item?.isAlternative,
  };
}

export async function extractPrescription(
  transcript: string,
  segments: { text: string; start: number; end: number }[] = [],
  opts: { alsoHeard?: string } = {},
): Promise<ExtractionResult> {
  const text = transcript.trim();
  if (!text) {
    return { items: [], diagnosis: null, notes: null, followUpDays: null, missing: [], model: MODEL, rawJson: null };
  }

  // Static content first (cacheable), the variable transcript last. The clinic's
  // brand list changes rarely, so it sits in the cached prefix too.
  const vocabulary = await medicineVocabulary().catch(() => [] as string[]);
  const { content, inputTokens, outputTokens } = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    ...(vocabulary.length
      ? [{ role: 'system' as const, content: `CLINIC'S MEDICINES (brand names its doctors use): ${vocabulary.join(', ')}.` }]
      : []),
    {
      role: 'user',
      content: `Transcript:\n"""${text}"""` + (opts.alsoHeard?.trim()
        // A second hearing of the SAME audio. Recognisers garble different words —
        // one writes "Monterell C" where the other wrote "Montair LC" — so the
        // extractor gets both, and takes a name or number from whichever wrote it
        // clearly. It adds no medicines of its own.
        ? `\n\nThe SAME speech, as a second recogniser heard it — the same medicines, not more:\n"""${opts.alsoHeard.trim()}"""\n` +
          'Where the two disagree on a medicine name, a strength or a number, take whichever is a clear real ' +
          'word or number; if both are clear and differ, keep the first. Never list a medicine twice.'
        : ''),
    },
  ]);

  const parsed = parseLoose(content);
  const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items : [];

  const items = rawItems.map((it) => {
    const built = reconcile(it, text);
    const { start, end } = locate(built.sourceText, segments);
    return { ...built, sourceStart: start, sourceEnd: end };
  });

  const missing = Array.isArray(parsed?.missing) ? parsed.missing.map(String) : [];
  // Our own omission sweep, independent of the model. Omissions are 54-86% of
  // ambient-scribe errors and the class both machines and humans are near-blind
  // to (AUC 0.50-0.63) for the structural reason that nothing on the page points
  // at them. So we state them rather than hoping anyone notices.
  for (const it of items) {
    if (!it.frequencyCode) missing.push(`${it.name}: no frequency stated`);
    if (it.durationValue == null && it.frequencyCode !== 'STAT') missing.push(`${it.name}: no duration stated`);
  }

  logger.info({ model: MODEL, inputTokens, outputTokens, items: items.length }, 'voiceRx: extraction complete');

  return {
    items,
    diagnosis: parsed?.diagnosis ? String(parsed.diagnosis) : null,
    notes: parsed?.notes ? String(parsed.notes) : null,
    followUpDays: parsed?.followUpDays != null ? Number(parsed.followUpDays) : null,
    missing: Array.from(new Set(missing)),
    model: MODEL,
    rawJson: parsed,
  };
}

export function extractionConfigured(): boolean {
  return !!API_KEY;
}

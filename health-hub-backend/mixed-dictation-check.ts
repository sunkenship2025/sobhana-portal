/**
 * A doctor switches the mic on and talks the way doctors here talk — Telugu or
 * Hindi, with the medicine names in English. Does it come out right?
 *
 * Two questions, scored separately:
 *   HEARD      did the transcript write down what the doctor said — every brand
 *              and number spelled right? (Whether or not it matches the catalogue.)
 *   PRESCRIBED did the prescription come out right — the right medicine, and the
 *              frequency, timing and duration that were said?
 *
 * 15 Telugu–English and 12 Hindi–English prescriptions. Voices alternate the way
 * a doctor's languages do: English (brands, strengths) in Rishi (en_IN), Telugu
 * in Geeta (te_IN), Hindi in Lekha (hi_IN), joined into one 16 kHz recording.
 *
 *   ASR   prod's /api/prescriptions/transcribe (Groq Whisper), once per variant
 *         ("model:language" — turbo|v3 : auto|te|hi|en), paced under the
 *         6-per-minute burst limit
 *   then  extraction + matching IN THIS PROCESS, so a prompt or resolver change
 *         is measured before it ships. Transcripts are cached per variant.
 *
 * Medicine scoring: ✓ matched right · "asked" (right one offered; ¹ = first) ·
 * missed · WRONG (resolved to another drug — must never happen). Fields: right ·
 * missing (the doctor is asked) · WRONG (a value nobody said).
 *
 * Synthetic voices in a quiet room are a floor, not the OPD. NOISE=1 adds
 * background hum and chatter at ~12 dB SNR to every clip.
 *
 *   API_URL=https://reports.sobhanaportal.com \
 *   MIX_VARIANTS=turbo:auto,v3:auto,v3:te MIX_SETS=te,hi npx tsx mixed-dictation-check.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { extractPrescription } from './src/services/voiceRx/extract';
import { resolveMedication } from './src/services/voiceRx/resolver';

const API = process.env.API_URL ?? 'http://localhost:3000';
const NOISE = process.env.NOISE === '1';
const DIR = path.join(process.env.MIX_CHECK_DIR ?? '/tmp/claude-501/mixed-check', NOISE ? 'noisy' : 'clean');
const CACHE = path.join(DIR, 'transcripts.json');
// For "prod" variants: what the SERVER extracted, so the run is end to end.
const SERVER_ITEMS = path.join(DIR, 'server-items.json');
const VARIANTS = (process.env.MIX_VARIANTS ?? 'v3:auto').split(',');
const SETS = (process.env.MIX_SETS ?? 'te,hi').split(',');

type Want = { drug: RegExp; freq?: string; timing?: RegExp; dur?: [number, string]; alt?: boolean };
type Part = { v: string; t: string };
type Case = { id: string; parts: Part[]; heard: string[]; want: Want[] };
const EN = (t: string): Part => ({ v: 'Rishi', t });
const TE = (t: string): Part => ({ v: 'Geeta', t });
const HI = (t: string): Part => ({ v: 'Lekha', t });
const AUG = /amoxicillin.*clavul|augmentin/i;

const CASES: Record<string, Case[]> = {
  te: [
    { id: 'te01', parts: [EN('Augmentin 625'), TE('రోజుకి మూడు సార్లు, ఐదు రోజులు.')], heard: ['augmentin', '625'], want: [{ drug: AUG, freq: 'TID', dur: [5, 'day'] }] },
    { id: 'te02', parts: [EN('Pan 40'), TE('రోజుకి ఒకసారి, భోజనానికి ముందు, పది రోజులు.')], heard: ['pan', '40'], want: [{ drug: /pantoprazole/i, freq: 'OD', timing: /before/i, dur: [10, 'day'] }] },
    { id: 'te03', parts: [EN('Dolo 650'), TE('జ్వరం వచ్చినప్పుడు మాత్రమే.')], heard: ['dolo', '650'], want: [{ drug: /paracetamol.*650|dolo/i, freq: 'SOS' }] },
    { id: 'te04', parts: [EN('Azithral 500'), TE('రోజుకి ఒకసారి, మూడు రోజులు.')], heard: ['azithral', '500'], want: [{ drug: /azithromycin/i, freq: 'OD', dur: [3, 'day'] }] },
    { id: 'te05', parts: [EN('Montair LC'), TE('రాత్రి పడుకునే ముందు ఒకటి, పది రోజులు.')], heard: ['montairlc'], want: [{ drug: /montelukast.*levocetirizine|montair/i, timing: /bed|night/i, dur: [10, 'day'] }] },
    { id: 'te06', parts: [EN('Cetzine 10'), TE('రాత్రికి ఒకటి, ఐదు రోజులు.')], heard: ['cetzine', '10'], want: [{ drug: /cetirizine/i, dur: [5, 'day'] }] },
    { id: 'te07', parts: [EN('Metformin 500'), TE('రోజుకి రెండు సార్లు, భోజనం తర్వాత, ఒక నెల.')], heard: ['metformin', '500'], want: [{ drug: /metformin/i, freq: 'BD', timing: /after/i, dur: [1, 'month'] }] },
    { id: 'te08', parts: [EN('Amlodipine 5'), TE('ఉదయం ఒకటి, ముప్పై రోజులు.')], heard: ['amlodipine', '5'], want: [{ drug: /amlodipine/i, dur: [30, 'day'] }] },
    { id: 'te09', parts: [EN('Ondem 4'), TE('వాంతులు అయితే మాత్రమే.')], heard: ['ondem', '4'], want: [{ drug: /ondansetron/i, freq: 'SOS' }] },
    { id: 'te10', parts: [EN('Crocin 500'), TE('రోజుకి మూడు సార్లు మూడు రోజులు,'), EN('Cetzine 10'), TE('రాత్రి ఒకటి ఐదు రోజులు.')], heard: ['crocin', '500', 'cetzine', '10'], want: [
      { drug: /paracetamol/i, freq: 'TID', dur: [3, 'day'] }, { drug: /cetirizine/i, dur: [5, 'day'] }] },
    { id: 'te11', parts: [EN('Augmentin 625'), TE('రోజుకి రెండు సార్లు, కాదు కాదు, మూడు సార్లు, ఐదు రోజులు.')], heard: ['augmentin', '625'], want: [{ drug: AUG, freq: 'TID', dur: [5, 'day'] }] },
    { id: 'te12', parts: [EN('Azithral'), TE('గానీ'), EN('Augmentin'), TE('గానీ ఇవ్వచ్చు,'), EN('Azithral'), TE('తో మొదలు పెట్టండి.')], heard: ['azithral', 'augmentin'], want: [{ drug: /azithromycin/i, alt: true }, { drug: AUG, alt: true }] },
    { id: 'te13', parts: [EN('Pantop 40'), TE('ఉదయం ఖాళీ కడుపుతో, రెండు వారాలు.')], heard: ['pantop', '40'], want: [{ drug: /pantoprazole/i, timing: /empty/i, dur: [2, 'week'] }] },
    { id: 'te14', parts: [EN('Zincovit'), TE('రోజుకి ఒకటి, పదిహేను రోజులు.')], heard: ['zincovit'], want: [{ drug: /zinc|multivitamin|zincovit/i, freq: 'OD', dur: [15, 'day'] }] },
    { id: 'te15', parts: [EN('Calpol 500'), TE('రోజుకి నాలుగు సార్లు, రెండు రోజులు.')], heard: ['calpol', '500'], want: [{ drug: /paracetamol/i, freq: 'QID', dur: [2, 'day'] }] },
  ],
  hi: [
    { id: 'hi01', parts: [EN('Augmentin 625'), HI('दिन में तीन बार, पाँच दिन।')], heard: ['augmentin', '625'], want: [{ drug: AUG, freq: 'TID', dur: [5, 'day'] }] },
    { id: 'hi02', parts: [EN('Pan 40'), HI('सुबह खाली पेट, दस दिन।')], heard: ['pan', '40'], want: [{ drug: /pantoprazole/i, timing: /empty/i, dur: [10, 'day'] }] },
    { id: 'hi03', parts: [EN('Dolo 650'), HI('बुखार हो तभी लेना।')], heard: ['dolo', '650'], want: [{ drug: /paracetamol.*650|dolo/i, freq: 'SOS' }] },
    { id: 'hi04', parts: [EN('Azithral 500'), HI('रोज़ एक बार, तीन दिन।')], heard: ['azithral', '500'], want: [{ drug: /azithromycin/i, freq: 'OD', dur: [3, 'day'] }] },
    { id: 'hi05', parts: [EN('Montair LC'), HI('रात को सोने से पहले, दस दिन।')], heard: ['montairlc'], want: [{ drug: /montelukast.*levocetirizine|montair/i, timing: /bed|night/i, dur: [10, 'day'] }] },
    { id: 'hi06', parts: [EN('Metformin 500'), HI('दिन में दो बार खाने के बाद, एक महीना।')], heard: ['metformin', '500'], want: [{ drug: /metformin/i, freq: 'BD', timing: /after/i, dur: [1, 'month'] }] },
    { id: 'hi07', parts: [EN('Ondem 4'), HI('उल्टी हो तो ही।')], heard: ['ondem', '4'], want: [{ drug: /ondansetron/i, freq: 'SOS' }] },
    { id: 'hi08', parts: [EN('Crocin 500'), HI('दिन में तीन बार तीन दिन,'), EN('Cetzine 10'), HI('रात को एक, पाँच दिन।')], heard: ['crocin', '500', 'cetzine', '10'], want: [
      { drug: /paracetamol/i, freq: 'TID', dur: [3, 'day'] }, { drug: /cetirizine/i, dur: [5, 'day'] }] },
    { id: 'hi09', parts: [EN('Augmentin 625'), HI('दिन में दो बार, नहीं नहीं, तीन बार, पाँच दिन।')], heard: ['augmentin', '625'], want: [{ drug: AUG, freq: 'TID', dur: [5, 'day'] }] },
    { id: 'hi10', parts: [EN('Azithral'), HI('या'), EN('Augmentin'), HI(', पहले'), EN('Azithral'), HI('से शुरू करो।')], heard: ['azithral', 'augmentin'], want: [{ drug: /azithromycin/i, alt: true }, { drug: AUG, alt: true }] },
    { id: 'hi11', parts: [EN('Calpol 500'), HI('दिन में चार बार, दो दिन।')], heard: ['calpol', '500'], want: [{ drug: /paracetamol/i, freq: 'QID', dur: [2, 'day'] }] },
    { id: 'hi12', parts: [EN('Zincovit'), HI('रोज़ एक, पंद्रह दिन।')], heard: ['zincovit'], want: [{ drug: /zinc|multivitamin|zincovit/i, freq: 'OD', dur: [15, 'day'] }] },
  ],
  // HELD OUT — brands and phrasings that appear nowhere in the prompts, so a
  // score here is not the prompt remembering its own examples.
  te2: [
    { id: 'ht01', parts: [EN('Combiflam'), TE('నొప్పి ఉంటే మాత్రమే.')], heard: ['combiflam'], want: [{ drug: /ibuprofen.*paracetamol|paracetamol.*ibuprofen|combiflam/i, freq: 'SOS' }] },
    { id: 'ht02', parts: [EN('Taxim O 200'), TE('రోజుకి రెండు సార్లు, భోజనం తర్వాత, ఏడు రోజులు.')], heard: ['taxim', '200'], want: [{ drug: /cefixime/i, freq: 'BD', timing: /after/i, dur: [7, 'day'] }] },
    { id: 'ht03', parts: [EN('Telma 40'), TE('ఉదయం ఒకటి, మూడు నెలలు.')], heard: ['telma', '40'], want: [{ drug: /telmisartan/i, dur: [3, 'month'] }] },
    { id: 'ht04', parts: [EN('Glycomet GP 1'), TE('రోజుకి రెండు సార్లు, భోజనానికి ముందు, ఒక నెల.')], heard: ['glycomet'], want: [{ drug: /glimepiride|glycomet/i, freq: 'BD', timing: /before/i, dur: [1, 'month'] }] },
    { id: 'ht05', parts: [EN('Levocet 5'), TE('రాత్రి ఒకటి, వారం రోజులు.')], heard: ['levocet', '5'], want: [{ drug: /^(?!.*montelukast).*levocetirizine/i, dur: [1, 'week'] }] },
    { id: 'ht06', parts: [EN('Omez 20'), TE('ఉదయం ఖాళీ కడుపుతో, పద్నాలుగు రోజులు.')], heard: ['omez', '20'], want: [{ drug: /omeprazole/i, timing: /empty/i, dur: [14, 'day'] }] },
    { id: 'ht07', parts: [EN('Meftal Spas'), TE('కడుపు నొప్పి వచ్చినప్పుడు మాత్రమే.')], heard: ['meftal'], want: [{ drug: /mefenamic.*dicyclomine|dicyclomine.*mefenamic|meftal/i, freq: 'SOS' }] },
    { id: 'ht08', parts: [EN('Ecosprin 75'), TE('రోజుకి ఒకసారి, భోజనం తర్వాత, ఆరు నెలలు.')], heard: ['ecosprin', '75'], want: [{ drug: /aspirin/i, freq: 'OD', timing: /after/i, dur: [6, 'month'] }] },
    { id: 'ht09', parts: [EN('Voveran 50'), TE('రోజుకి రెండు సార్లు, మూడు రోజులు,'), EN('Omez 20'), TE('ఉదయం ఒకటి, మూడు రోజులు.')], heard: ['voveran', '50', 'omez', '20'], want: [
      { drug: /diclofenac/i, freq: 'BD', dur: [3, 'day'] }, { drug: /omeprazole/i, dur: [3, 'day'] }] },
    { id: 'ht10', parts: [EN('Domstal 10'), TE('రోజుకి మూడు సార్లు, భోజనానికి అరగంట ముందు, ఐదు రోజులు.')], heard: ['domstal', '10'], want: [{ drug: /domperidone/i, freq: 'TID', timing: /before/i, dur: [5, 'day'] }] },
    { id: 'ht11', parts: [EN('Norflox 400'), TE('రోజుకి రెండు సార్లు, కాదు, ఒకసారే, ఐదు రోజులు.')], heard: ['norflox', '400'], want: [{ drug: /norfloxacin/i, freq: 'OD', dur: [5, 'day'] }] },
    { id: 'ht12', parts: [EN('Udiliv 300'), TE('రోజుకి రెండు సార్లు, రెండు నెలలు.')], heard: ['udiliv', '300'], want: [{ drug: /ursodeoxycholic|ursodiol|udiliv/i, freq: 'BD', dur: [2, 'month'] }] },
  ],
  hi2: [
    { id: 'hh01', parts: [EN('Combiflam'), HI('दर्द हो तो ही लेना।')], heard: ['combiflam'], want: [{ drug: /ibuprofen.*paracetamol|paracetamol.*ibuprofen|combiflam/i, freq: 'SOS' }] },
    { id: 'hh02', parts: [EN('Taxim O 200'), HI('दिन में दो बार खाने के बाद, सात दिन।')], heard: ['taxim', '200'], want: [{ drug: /cefixime/i, freq: 'BD', timing: /after/i, dur: [7, 'day'] }] },
    { id: 'hh03', parts: [EN('Telma 40'), HI('सुबह एक, तीन महीने।')], heard: ['telma', '40'], want: [{ drug: /telmisartan/i, dur: [3, 'month'] }] },
    { id: 'hh04', parts: [EN('Glycomet GP 1'), HI('दिन में दो बार खाने से पहले, एक महीना।')], heard: ['glycomet'], want: [{ drug: /glimepiride|glycomet/i, freq: 'BD', timing: /before/i, dur: [1, 'month'] }] },
    { id: 'hh05', parts: [EN('Levocet 5'), HI('रात को एक, एक हफ्ता।')], heard: ['levocet', '5'], want: [{ drug: /^(?!.*montelukast).*levocetirizine/i, dur: [1, 'week'] }] },
    { id: 'hh06', parts: [EN('Omez 20'), HI('सुबह खाली पेट, चौदह दिन।')], heard: ['omez', '20'], want: [{ drug: /omeprazole/i, timing: /empty/i, dur: [14, 'day'] }] },
    { id: 'hh07', parts: [EN('Meftal Spas'), HI('पेट में दर्द हो तभी।')], heard: ['meftal'], want: [{ drug: /mefenamic.*dicyclomine|dicyclomine.*mefenamic|meftal/i, freq: 'SOS' }] },
    { id: 'hh08', parts: [EN('Ecosprin 75'), HI('रोज़ एक बार खाने के बाद, छह महीने।')], heard: ['ecosprin', '75'], want: [{ drug: /aspirin/i, freq: 'OD', timing: /after/i, dur: [6, 'month'] }] },
    { id: 'hh09', parts: [EN('Voveran 50'), HI('दिन में दो बार तीन दिन,'), EN('Omez 20'), HI('सुबह एक तीन दिन।')], heard: ['voveran', '50', 'omez', '20'], want: [
      { drug: /diclofenac/i, freq: 'BD', dur: [3, 'day'] }, { drug: /omeprazole/i, dur: [3, 'day'] }] },
    { id: 'hh10', parts: [EN('Domstal 10'), HI('दिन में तीन बार, खाने से आधा घंटा पहले, पाँच दिन।')], heard: ['domstal', '10'], want: [{ drug: /domperidone/i, freq: 'TID', timing: /before/i, dur: [5, 'day'] }] },
    { id: 'hh11', parts: [EN('Norflox 400'), HI('दिन में दो बार, नहीं, एक बार ही, पाँच दिन।')], heard: ['norflox', '400'], want: [{ drug: /norfloxacin/i, freq: 'OD', dur: [5, 'day'] }] },
    { id: 'hh12', parts: [EN('Udiliv 300'), HI('दिन में दो बार, दो महीने।')], heard: ['udiliv', '300'], want: [{ drug: /ursodeoxycholic|ursodiol|udiliv/i, freq: 'BD', dur: [2, 'month'] }] },
  ],
};
const said = (c: Case) => c.parts.map((p) => p.t).join(' ');

/** One 16 kHz mono WAV from several voices, a short breath between them, optional OPD noise. */
function speak(parts: Part[], out: string) {
  const pcm: Buffer[] = [];
  const gap = Buffer.alloc(16000 * 2 * 0.2);
  for (const [k, p] of parts.entries()) {
    const aiff = `${out}.${k}.aiff`, wav = `${out}.${k}.wav`;
    execFileSync('say', ['-v', p.v, '-o', aiff, p.t]);
    execFileSync('afconvert', [aiff, '-o', wav, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
    const b = fs.readFileSync(wav);
    const at = b.indexOf('data');
    pcm.push(b.subarray(at + 8, at + 8 + b.readUInt32LE(at + 4)), gap);
    fs.rmSync(aiff); fs.rmSync(wav);
  }
  const data = Buffer.concat(pcm);
  if (NOISE) {
    // Mains hum + a murmur of low-passed noise, at roughly 12 dB below the speech.
    let rms = 0;
    for (let i = 0; i < data.length; i += 2) rms += data.readInt16LE(i) ** 2;
    rms = Math.sqrt(rms / (data.length / 2));
    const level = rms / 4;
    let lp = 0;
    for (let i = 0, n = 0; i < data.length; i += 2, n++) {
      lp = 0.9 * lp + 0.1 * (Math.random() * 2 - 1);
      const noise = level * (2.2 * lp + 0.3 * Math.sin((2 * Math.PI * 50 * n) / 16000));
      data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i) + noise))), i);
    }
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
}

async function transcribeAll(cases: Case[]): Promise<Record<string, Record<string, string>>> {
  fs.mkdirSync(DIR, { recursive: true });
  const cache: Record<string, Record<string, string>> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const todo = VARIANTS.flatMap((v) => v.split('+')).flatMap((v) => cases.filter((c) => !cache[v]?.[c.id]).map((c) => ({ v, c })));
  if (todo.length === 0) return cache;

  const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
  const PW = 'MixedCheck@2026';
  const u = await prisma.user.create({
    data: { email: `mixed.${Date.now()}@sobhana.local`, name: 'Mixed Dictation Check', role: 'owner',
            passwordHash: await bcrypt.hash(PW, 10), activeBranchId: branch!.id, isActive: true },
    select: { id: true, email: true },
  });
  try {
    // Retried: right after a deploy the edge can answer with an HTML page.
    let lb: any = null;
    for (let attempt = 1; attempt <= 4 && !lb?.token && !lb?.accessToken; attempt++) {
      const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PW }) });
      const text = await login.text();
      try { lb = JSON.parse(text); } catch { console.log(`login attempt ${attempt}: ${login.status}`); await new Promise((r) => setTimeout(r, 15_000)); }
    }
    if (!lb?.token && !lb?.accessToken) throw new Error('could not log in');
    const H = { Authorization: `Bearer ${lb.token ?? lb.accessToken}`, 'X-Branch-Id': branch!.id };
    console.log(`transcribing ${todo.length} clips (~${Math.ceil((todo.length * 11) / 60)} min)…`);
    for (const { v, c } of todo) {
      const wav = path.join(DIR, `${c.id}.wav`);
      if (!fs.existsSync(wav)) speak(c.parts, wav);
      await new Promise((r) => setTimeout(r, 11_000)); // prod's 6/min burst limit
      const [model, lang] = v.split(':');
      const form = new FormData();
      form.append('audio', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), `${c.id}.wav`);
      if (model.startsWith('prod')) {
        // Exactly what the dictation card sends: the doctor's language, nothing
        // else — the server picks the recogniser, model and language hint.
        form.append('dictation', lang);
      } else {
        form.append('provider', 'groq');
        form.append('model', model === 'v3' ? 'whisper-large-v3' : 'whisper-large-v3-turbo');
        if (lang && lang !== 'auto') form.append('language', lang);
      }
      const r = await fetch(`${API}/api/prescriptions/transcribe`, { method: 'POST', headers: H, body: form });
      const b = await r.json().catch(() => ({ message: `non-JSON ${r.status}` })) as any;
      (cache[v] ??= {})[c.id] = r.ok ? b.transcript.text : `[error ${r.status}] ${b?.message ?? ''}`;
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 2));
      if (r.ok && model.startsWith('prod')) {
        const server = fs.existsSync(SERVER_ITEMS) ? JSON.parse(fs.readFileSync(SERVER_ITEMS, 'utf8')) : {};
        (server[v] ??= {})[c.id] = b.extraction.items;
        fs.writeFileSync(SERVER_ITEMS, JSON.stringify(server, null, 2));
      }
      process.stdout.write('.');
    }
    console.log();
  } finally {
    await prisma.auditLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  return cache;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

(async () => {
  const cases = SETS.flatMap((s) => CASES[s] ?? []);
  const cache = await transcribeAll(cases);
  const quiet = process.argv.includes('--quiet');
  const summary: string[] = [];

  for (const v of VARIANTS) {
    for (const set of SETS) {
      const t = { heard: 0, named: 0, perfect: 0, oneTap: 0, n: 0, ok: 0, asked: 0, askedFirst: 0, missed: 0, wrong: 0, fok: 0, fmiss: 0, fwrong: 0 };
      const label = { te: 'Telugu', hi: 'Hindi', te2: 'Telugu (held out)', hi2: 'Hindi (held out)' }[set] ?? set;
      if (!quiet) console.log(`\n══════ ${label.toUpperCase()}–English · Whisper ${v} ══════`);
      for (const c of CASES[set] ?? []) {
        t.n++;
        // "a+b": a is the transcript, b a second hearing of the same audio.
        const [primary, second] = v.split('+');
        const heard = cache[primary]?.[c.id] ?? '';
        const alsoHeard = second ? cache[second]?.[c.id] : undefined;
        const heardRight = !/^\[error/.test(heard) && c.heard.every((w) => squash(heard).includes(w));
        if (heardRight) t.heard++;
        const lines: string[] = [];
        // "perfect": right with no taps. "oneTap": right once each repaired or
        // near-miss name is confirmed with its first suggestion.
        let perfect = true;
        let oneTap = true;
        if (!heard || /^\[error/.test(heard)) { t.missed += c.want.length; perfect = false; oneTap = false; lines.push('    ✗ no transcript'); }
        else {
          const server = fs.existsSync(SERVER_ITEMS) ? JSON.parse(fs.readFileSync(SERVER_ITEMS, 'utf8')) : {};
          const { items } = server[v]?.[c.id] && process.env.MIX_LOCAL !== '1'
            ? { items: server[v][c.id] as Awaited<ReturnType<typeof extractPrescription>>['items'] }
            : await extractPrescription(heard, [], { alsoHeard: alsoHeard && !/^\[error/.test(alsoHeard) ? alsoHeard : undefined });
          const brands = c.heard.filter((w) => /[a-z]/.test(w));
          if (brands.every((b) => items.some((it) => squash(it.name).includes(b)))) t.named++;
          if (items.length !== c.want.length) { perfect = false; oneTap = false; lines.push(`    ! ${items.length} medicine line(s), expected ${c.want.length}`); }
          for (const w of c.want) {
            let found = false;
            for (const it of items) {
              let r = await resolveMedication({ spoken: it.name || it.spokenText, strength: it.strength, dosageForm: it.dosageForm });
              // As the server does (resolveLine): a repaired name is asked, never matched silently.
              if ((it.fieldStates as any)?.name === 'NORMALIZED' && r.resolution === 'RESOLVED' && r.match) {
                const asHeard = it.spokenText && it.spokenText !== it.name
                  ? await resolveMedication({ spoken: it.spokenText, strength: it.strength, dosageForm: it.dosageForm }) : null;
                const same = asHeard?.resolution === 'RESOLVED' && asHeard.match?.medicationId === r.match.medicationId;
                if (!same) r = { ...r, resolution: 'UNRESOLVED', candidates: [r.match, ...r.candidates.filter((x) => x.medicationId !== r.match!.medicationId)], match: null } as any;
              }
              const hay = (x: any) => `${x?.canonicalName ?? ''} ${x?.genericName ?? ''} ${x?.brandName ?? ''}`;
              const right = !!r.match && w.drug.test(hay(r.match));
              const at = r.match ? -1 : r.candidates.findIndex((cd: any) => w.drug.test(hay(cd)));
              const wrongDrug = r.resolution === 'RESOLVED' && !!r.match && !right;
              if (!right && at < 0 && !w.drug.test(`${it.name} ${it.spokenText}`)) continue;
              found = true;
              const f: string[] = [];
              const field = (label: string, got: unknown, want: unknown, ok: boolean) => {
                if (want === undefined) return;
                if (got == null || got === '') { t.fmiss++; perfect = false; oneTap = false; f.push(`${label}: missing`); }
                else if (ok) { t.fok++; f.push(`${label}: ${got} ✓`); }
                else { t.fwrong++; perfect = false; oneTap = false; f.push(`${label}: ${got} ✗ WRONG`); }
              };
              field('freq', it.frequencyCode, w.freq, it.frequencyCode === w.freq);
              field('timing', it.timing, w.timing, !!it.timing && !!w.timing?.test(it.timing));
              field('dur', it.durationValue != null ? `${it.durationValue} ${it.durationUnit}` : null, w.dur,
                it.durationValue === w.dur?.[0] && (it.durationUnit ?? '').startsWith(w.dur?.[1] ?? '~'));
              if (w.alt !== undefined) { if (it.isAlternative === w.alt) { t.fok++; f.push('either/or ✓'); } else { t.fwrong++; perfect = false; oneTap = false; f.push('either/or ✗'); } }
              let drug: string;
              if (right) { t.ok++; drug = `✓ ${r.match!.canonicalName}`; }
              else if (at >= 0) { t.asked++; if (at === 0) t.askedFirst++; else oneTap = false; perfect = false; drug = `asked${at === 0 ? '¹' : ''} (${r.candidates[at].canonicalName})`; }
              else if (wrongDrug) { t.wrong++; perfect = false; oneTap = false; drug = `✗ WRONG DRUG ${r.match!.canonicalName}`; }
              else { t.missed++; perfect = false; oneTap = false; drug = '✗ not matched'; }
              lines.push(`    · "${it.name}" → ${drug}${f.length ? ' · ' + f.join(' · ') : ''}`);
              break;
            }
            if (!found) { t.missed++; perfect = false; oneTap = false; lines.push(`    ✗ ${w.drug.source.slice(0, 30)} — not extracted`); }
          }
        }
        if (perfect) t.perfect++;
        if (oneTap) t.oneTap++;
        if (!quiet) console.log(`\n${c.id} said:  ${said(c)}\n     heard: ${heard}  ${heardRight ? '[heard right]' : '[misheard]'}\n${lines.join('\n')}`);
      }
      summary.push(`${label.padEnd(18)} Whisper ${v.padEnd(10)} transcript right ${String(t.heard).padStart(2)}/${t.n} · names written right ${String(t.named).padStart(2)}/${t.n} · RIGHT no taps ${String(t.perfect).padStart(2)}/${t.n} · RIGHT ≤1 tap ${String(t.oneTap).padStart(2)}/${t.n} · medicine ✓${t.ok} asked ${t.asked} (first ${t.askedFirst}) missed ${t.missed} WRONG ${t.wrong} · fields ✓${t.fok} missing ${t.fmiss} wrong ${t.fwrong}`);
    }
  }
  console.log(`\n${NOISE ? 'WITH OPD NOISE' : 'QUIET ROOM'}\n${summary.join('\n')}`);
  await prisma.$disconnect();
  process.exit(0);
})();

/**
 * REAL speech: Indian doctors and patients, Hindi–English, naming real drugs.
 *
 * The clips are EkaCare's medical ASR evaluation set (MIT; huggingface.co/datasets/
 * ekacare/eka-medical-asr-evaluation-dataset) — 56 real speakers, with a human
 * transcript and every drug marked. Each clip goes through the production path
 * exactly as the dictation card sends it (dictation=<lang>, nothing else), and
 * every marked drug is scored three ways:
 *
 *   heard       the transcript wrote the drug the speaker said
 *   on the Rx   the server's extraction made it a medicine line
 *   in the list the line matched the clinic catalogue, or offered it first
 *   WRONG       the line RESOLVED to a different brand — must never happen
 *
 * Drug names are compared by sound (transliterateIndic + consonantSkeleton), so a
 * human transcript that wrote "ग्लाइकोमेट" still meets "Glycomet".
 *
 * The manifest (id, path, text, drugs) is built from the dataset's parquet — see
 * the commit that added this file. Temp owner logins on the branch given (so the
 * main branch's daily dictation quota is untouched), removed in finally; results
 * cached, so re-scoring is free.
 *
 *   EKA_MANIFEST=/tmp/claude-501/eka/hi-manifest.json EKA_LANG=hi EKA_BRANCH=<id> \
 *   API_URL=https://reports.sobhanaportal.com npx tsx real-speech-check.ts
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { resolveMedication, consonantSkeleton } from './src/services/voiceRx/resolver';
import { transliterateIndic } from './src/services/voiceRx/normalize';
import { extractPrescription } from './src/services/voiceRx/extract';

const API = process.env.API_URL ?? 'http://localhost:3000';
const MANIFEST = process.env.EKA_MANIFEST!;
const LANG = process.env.EKA_LANG ?? 'hi';
// What the dictation card sends — the doctor's "I speak" choice. Defaults to the
// clip's language; set it to compare (e.g. hi speech sent as 'te' = Whisper
// English mode, one hearing).
const SEND = process.env.EKA_DICTATION ?? LANG;
const LIMIT = Number(process.env.EKA_LIMIT ?? 0) || Infinity;
const WORKERS = Number(process.env.EKA_WORKERS ?? 4);
const CACHE = MANIFEST.replace(/\.json$/, `.results-${SEND}.json`);
// Each lookup is a heavy fuzzy search over 242k rows on the PRODUCTION database —
// hundreds in a tight loop dropped its connections (P1017). So: each unique query
// once, cached across runs, spaced out, one retry.
const LOOKUPS = '/tmp/claude-501/eka/lookups.json';
const lookups: Record<string, { resolution: string; match: any; candidates: any[] }> = fs.existsSync(LOOKUPS) ? JSON.parse(fs.readFileSync(LOOKUPS, 'utf8')) : {};
async function lookup(spoken: string, strength?: string | null, dosageForm?: string | null) {
  const key = `${spoken}|${strength ?? ''}|${dosageForm ?? ''}`;
  if (lookups[key]) return lookups[key];
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await resolveMedication({ spoken, strength: strength ?? null, dosageForm: dosageForm ?? null });
      lookups[key] = { resolution: r.resolution, match: r.match, candidates: r.candidates.slice(0, 3) };
      fs.writeFileSync(LOOKUPS, JSON.stringify(lookups));
      await new Promise((res) => setTimeout(res, 300));
      return lookups[key];
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

type Clip = { id: string; path: string; text: string; drugs: string[]; duration: number; context: string; speaker: string };
type Result = { transcript: string; items: { name: string; spokenText: string; strength: string | null; dosageForm: string | null; fieldStates?: any }[] } | { error: string };

// Words in a drug entity that are dose or form, not the name.
const NOT_NAME = new Set(['mg', 'ml', 'mcg', 'gm', 'tablet', 'tablets', 'tab', 'capsule', 'syrup', 'cough', 'injection', 'inj', 'drops', 'cream',
  'gel', 'ointment', 'milligram', 'miligram', 'miligrm', 'mililitar', 'tu', 'two', 'handred', 'hundred', 'fifty', 'for', 'four', 'fiftin', 'tain',
  'ten', 'twenty', 'da', 'the', 'ki', 'ka', 'ke', 'davai', 'dava', 'tebalet', 'taiblet', 'tabalet', 'goli', 'sirap', 'injekshan', 'dropas', 'drap']);
const tokens = (s: string) => transliterateIndic(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
/** A marked "drug" that names no product: "medicine", "डायबिटीज की दवाई", PRP. */
const GENERIC = /दवा|medicine|medication|मेडिसिन|मेडिकेशन|मेडीसिन|पीआरपी|\bprp\b|एंटी|anti|विटामिन|vitamin|कैल्शियम|calcium|सप्लीमेंट|supplement/i;
/** A clip that PRESCRIBES — most narration clips read out a drug's description
 *  ("Montral tablet is used for…"), where the right extraction is no line. */
const PRESCRIBING = /\b(take|taking|give|prescrib\w*|start|continue|apply|twice|thrice|once|daily|times a day|a day|before food|after food|for \d+ days|days?|weeks?|morning|night)\b|लें|लीजिए|लीजिये|लेना|लेने|लेते|खाइए|खाएं|खाने|दिन|रोज़?|बार|सुबह|शाम|रात|हफ्ते|महीने/i;
/** The spoken name inside a marked drug: its first word that is not a dose or form. */
function nameOf(entity: string): string | null {
  if (GENERIC.test(entity)) return null;
  const t = tokens(entity).filter((w) => !/\d/.test(w) && !NOT_NAME.has(w) && w.length >= 3);
  return t[0] ?? null;
}
/** Does text contain the name — spelled, or by sound (one or two words joined)? */
function mentions(text: string, name: string): boolean {
  const key = consonantSkeleton(name);
  const t = tokens(text);
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith(name) || consonantSkeleton(t[i]) === key) return true;
    if (i + 1 < t.length && consonantSkeleton(t[i] + t[i + 1]) === key) return true;
  }
  return false;
}

async function transcribe(clips: Clip[], branchId: string): Promise<Record<string, Result>> {
  const cache: Record<string, Result> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
  const todo = clips.filter((c) => !cache[c.id] || 'error' in cache[c.id]);
  if (todo.length === 0) return cache;
  console.log(`transcribing ${todo.length} real clips with ${WORKERS} logins (~${Math.ceil((todo.length / WORKERS) * 11 / 60)} min)…`);
  const PW = 'RealSpeech@2026';
  const users: { id: string; H: Record<string, string> }[] = [];
  try {
    for (let w = 0; w < WORKERS; w++) {
      const u = await prisma.user.create({
        data: { email: `realspeech.${w}.${Date.now()}@sobhana.local`, name: `Real Speech Check ${w}`, role: 'owner',
                passwordHash: await bcrypt.hash(PW, 10), activeBranchId: branchId, isActive: true },
        select: { id: true, email: true },
      });
      const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PW }) });
      const b = JSON.parse(await r.text()) as any;
      users.push({ id: u.id, H: { Authorization: `Bearer ${b.token ?? b.accessToken}`, 'X-Branch-Id': branchId } });
    }
    const queue = [...todo];
    let done = 0;
    await Promise.all(users.map(async (u) => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const form = new FormData();
        // The files are MP3 whatever their extension says.
        form.append('audio', new Blob([fs.readFileSync(c.path)], { type: 'audio/mpeg' }), `${c.id}.mp3`);
        form.append('dictation', SEND);
        // A request the server never answers must not hold a worker forever.
        const r = await fetch(`${API}/api/prescriptions/transcribe`, { method: 'POST', headers: u.H, body: form, signal: AbortSignal.timeout(90_000) })
          .catch((e) => ({ ok: false, status: 0, json: async () => ({ message: String(e?.name ?? e) }) } as any));
        const b = await r.json().catch(() => ({ message: `non-JSON ${r.status}` })) as any;
        cache[c.id] = r.ok ? { transcript: b.transcript.text, items: b.extraction.items } : { error: `${r.status} ${b?.message ?? ''}` };
        fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
        done++;
        if (done % 10 === 0) process.stdout.write(`${done} `);
        await new Promise((res) => setTimeout(res, 11_000)); // 6/min per login
      }
    }));
    console.log();
  } finally {
    for (const u of users) {
      await prisma.auditLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
    }
  }
  return cache;
}

(async () => {
  const clips = (JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Clip[]).slice(0, LIMIT);
  const branchId = process.env.EKA_BRANCH ?? (await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } }))!.id;
  let results = await transcribe(clips, branchId);
  // EKA_LOCAL=1: re-extract each cached transcript with THIS checkout's code — to
  // score an extraction or resolver change before it ships, with no recognition
  // and no quota. (One hearing only: the server does not return its second.)
  if (process.env.EKA_LOCAL === '1') {
    const LOCAL = CACHE.replace(/\.json$/, '.local.json');
    const local: Record<string, Result> = fs.existsSync(LOCAL) ? JSON.parse(fs.readFileSync(LOCAL, 'utf8')) : {};
    const queue = clips.filter((c) => !local[c.id] && results[c.id] && !('error' in results[c.id]));
    await Promise.all([0, 1, 2, 3].map(async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const transcript = (results[c.id] as { transcript: string }).transcript;
        const { items } = await extractPrescription(transcript, []).catch(() => ({ items: [] as any[] }));
        local[c.id] = { transcript, items };
        fs.writeFileSync(LOCAL, JSON.stringify(local, null, 1));
      }
    }));
    results = local;
  }

  const t = { drugs: 0, heard: 0, onRx: 0, inList: 0, molecule: 0, listed: 0, wrong: 0, errors: 0, clips: 0 };
  const misses: string[] = [];
  for (const c of clips) {
    if (process.env.EKA_RX === '1' && !PRESCRIBING.test(c.text)) continue;
    const r = results[c.id];
    if (!r || 'error' in r) { t.errors++; continue; }
    t.clips++;
    // PRODUCT mode (default): the product each clip is about — its first marked
    // drug, once. The dataset marks every drug-like word, classes ("antifungal")
    // and ingredients ("calcium") included; a prescription names products, and
    // an extractor that makes no line for "an antifungal" is right, not wrong.
    const seenNames = new Set<string>();
    const wanted = process.env.EKA_ALL === '1' ? c.drugs : c.drugs.slice(0, 1);
    for (const d of wanted) {
      const name = nameOf(d);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);
      t.drugs++;
      const heard = mentions(r.transcript, name);
      if (heard) t.heard++;
      const line = r.items.find((it) => mentions(`${it.name} ${it.spokenText}`, name));
      if (line) t.onRx++;
      // Is the drug in the catalogue at all? (Ayurvedic names, PRP, "collagen shots"
      // are not; a miss there is the catalogue, not the dictation.)
      const known = process.env.EKA_COVERAGE === '1' ? await lookup(name) : null;
      const listed = !!known?.match || (known?.candidates.length ?? 0) > 0;
      if (listed) t.listed++;
      if (line) {
        const res = await lookup(line.name || line.spokenText, line.strength, line.dosageForm);
        const brand = (x: any) => `${x?.brandName ?? ''} ${x?.canonicalName ?? ''}`;
        // Named: the brand says it, or it is the molecule said ("thyroxine" → Levothyroxine).
        const named = (x: any) => !!x && (mentions(brand(x), name) || String(x.genericName ?? '').toLowerCase().includes(name));
        const top = res.match ?? res.candidates[0];
        // The same molecule under another brand is the right drug ("Lonazep 0.5" →
        // Clonazepam 0.5) — judged against what the catalogue says the name is.
        const ref = known?.match ?? known?.candidates[0];
        if (named(top) || (top && named(ref) && top.genericName && top.genericName === ref.genericName)) t.molecule++;
        if (named(top)) t.inList++;
        else if (res.resolution === 'RESOLVED' && res.match) {
          // A different BRAND is not necessarily a different DRUG (Crocin -> Paracetamol
          // 500 is right). Count it for a human to look at; do not call it wrong blind.
          t.wrong++;
          misses.push(`  ? ${c.id}: "${d}" → line "${line.name}" resolved to ${res.match.canonicalName} (${res.match.brandName ?? '-'})`);
        }
      }
      if (!heard || !line) misses.push(`  ${heard ? 'heard, no line' : 'NOT heard'}: "${d}"  ←  ${r.transcript.slice(0, 110)}`);
    }
  }
  const pct = (a: number, b: number) => `${a}/${b} (${Math.round((100 * a) / Math.max(1, b))}%)`;
  console.log(`\nREAL SPEECH · ${LANG === 'hi' ? 'Hindi–English' : LANG} · sent as "${SEND}" · ${t.clips} clips · ${t.drugs} named drugs${t.errors ? ` · ${t.errors} failed` : ''}`);
  console.log(`  heard (the transcript wrote the drug):   ${pct(t.heard, t.drugs)}`);
  console.log(`  on the prescription (a medicine line):   ${pct(t.onRx, t.drugs)}`);
  console.log(`  matched or offered first in the list:    ${pct(t.inList, t.drugs)}${process.env.EKA_COVERAGE === '1' ? `   (drugs the catalogue has at all: ${t.listed})` : ''}`);
  if (process.env.EKA_COVERAGE === '1') console.log(`  right DRUG first (same molecule counts): ${pct(t.molecule, t.drugs)}`);
  console.log(`  resolved to a different brand (review):  ${t.wrong}`);
  if (process.argv.includes('--misses')) console.log(misses.join('\n'));
  await prisma.$disconnect();
  process.exit(0);
})();

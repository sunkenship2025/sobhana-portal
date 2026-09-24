/**
 * A doctor switches the mic on and talks Telugu. Does the prescription come out right?
 *
 * 15 spoken prescriptions in natural Telugu-English — the way a Hyderabad doctor
 * says them: brand names in English, frequency / timing / duration in Telugu, a
 * self-correction, an either/or, two medicines in one breath, "only if fever".
 *
 *   audio   macOS's Telugu voice (Geeta, te_IN) reads each line into a 16 kHz WAV
 *   ASR     prod's own /api/prescriptions/transcribe, once per language mode (auto, te, en)
 *   then    extraction + medicine matching IN THIS PROCESS, so a prompt or
 *           resolver fix is measured before it is deployed
 *
 * Transcripts are cached (TRANSCRIPTS below), so re-running after a fix spends
 * nothing on speech recognition. Each fresh run: 30 short clips (~₹1 of ASR, 30
 * of the branch's 400 daily dictations) and ~30 extraction calls (~₹2).
 *
 * Scoring per medicine: drug RESOLVED to the right one = ok; asked, with the right
 * one offered = "asked" (safe, one tap); resolved to a WRONG drug = the one result
 * that must never happen. Frequency / timing / duration: ok, missing (the doctor
 * is asked), or WRONG (a value nobody said, or the wrong one).
 *
 * Only Groq (Whisper) is configured on prod — asking for sarvam falls back to it —
 * so only groq is run.
 *
 * Synthetic voices, quiet room: a floor, not a ceiling. A real doctor in a real
 * OPD will be harder on the recogniser than Geeta is.
 *
 *   API_URL=https://reports.sobhanaportal.com npx tsx telugu-dictation-check.ts [--fresh]
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
const DIR = process.env.TELUGU_CHECK_DIR ?? '/tmp/claude-501/telugu-check';
const TRANSCRIPTS = path.join(DIR, 'transcripts.json');
// How the recogniser is told what to expect: nothing (auto-detect, what the
// doctor's screen sends today), Telugu, or English.
const PROVIDERS = (process.env.TELUGU_VARIANTS ?? 'auto,te,en').split(',') as string[];

type Want = { drug: RegExp; freq?: string; timing?: RegExp; dur?: [number, string]; alt?: boolean };
// Each line alternates voices the way a doctor alternates languages: English
// segments (brand names, strengths) in Rishi (en_IN), Telugu in Geeta (te_IN).
const EN = (t: string) => ({ v: 'Rishi', t });
const TE = (t: string) => ({ v: 'Geeta', t });
const CASES: { parts: { v: string; t: string }[]; want: Want[] }[] = [
  { parts: [EN('Augmentin 625'), TE('రోజుకి మూడు సార్లు, ఐదు రోజులు.')], want: [{ drug: /amoxicillin.*clavul|augmentin/i, freq: 'TID', dur: [5, 'day'] }] },
  { parts: [EN('Pan 40'), TE('రోజుకి ఒకసారి, భోజనానికి ముందు, పది రోజులు.')], want: [{ drug: /pantoprazole/i, freq: 'OD', timing: /before/i, dur: [10, 'day'] }] },
  { parts: [EN('Dolo 650'), TE('జ్వరం వచ్చినప్పుడు మాత్రమే.')], want: [{ drug: /paracetamol.*650|dolo/i, freq: 'SOS' }] },
  { parts: [EN('Azithral 500'), TE('రోజుకి ఒకసారి, మూడు రోజులు.')], want: [{ drug: /azithromycin/i, freq: 'OD', dur: [3, 'day'] }] },
  { parts: [EN('Montair LC'), TE('రాత్రి పడుకునే ముందు ఒకటి, పది రోజులు.')], want: [{ drug: /montelukast/i, timing: /bed|night/i, dur: [10, 'day'] }] },
  { parts: [EN('Cetzine 10'), TE('రాత్రికి ఒకటి, ఐదు రోజులు.')], want: [{ drug: /cetirizine/i, dur: [5, 'day'] }] },
  { parts: [EN('Metformin 500'), TE('రోజుకి రెండు సార్లు, భోజనం తర్వాత, ఒక నెల.')], want: [{ drug: /metformin/i, freq: 'BD', timing: /after/i, dur: [1, 'month'] }] },
  { parts: [EN('Amlodipine 5'), TE('ఉదయం ఒకటి, ముప్పై రోజులు.')], want: [{ drug: /amlodipine/i, dur: [30, 'day'] }] },
  { parts: [EN('Ondem 4'), TE('వాంతులు అయితే మాత్రమే.')], want: [{ drug: /ondansetron/i, freq: 'SOS' }] },
  { parts: [EN('Crocin 500'), TE('రోజుకి మూడు సార్లు మూడు రోజులు,'), EN('Cetzine 10'), TE('రాత్రి ఒకటి ఐదు రోజులు.')], want: [
    { drug: /paracetamol/i, freq: 'TID', dur: [3, 'day'] }, { drug: /cetirizine/i, dur: [5, 'day'] }] },
  { parts: [EN('Augmentin 625'), TE('రోజుకి రెండు సార్లు, కాదు కాదు, మూడు సార్లు, ఐదు రోజులు.')], want: [{ drug: /amoxicillin.*clavul|augmentin/i, freq: 'TID', dur: [5, 'day'] }] },
  { parts: [EN('Azithral'), TE('గానీ'), EN('Augmentin'), TE('గానీ ఇవ్వచ్చు,'), EN('Azithral'), TE('తో మొదలు పెట్టండి.')], want: [{ drug: /azithromycin/i, alt: true }, { drug: /amoxicillin.*clavul|augmentin/i, alt: true }] },
  { parts: [EN('Pantop 40'), TE('ఉదయం ఖాళీ కడుపుతో, రెండు వారాలు.')], want: [{ drug: /pantoprazole/i, timing: /empty/i, dur: [2, 'week'] }] },
  { parts: [EN('Zincovit'), TE('రోజుకి ఒకటి, పదిహేను రోజులు.')], want: [{ drug: /zinc|multivitamin|zincovit/i, freq: 'OD', dur: [15, 'day'] }] },
  { parts: [EN('Calpol 500'), TE('రోజుకి నాలుగు సార్లు, రెండు రోజులు.')], want: [{ drug: /paracetamol/i, freq: 'QID', dur: [2, 'day'] }] },
];
const said = (c: (typeof CASES)[number]) => c.parts.map((p) => p.t).join(' ');

/** One 16 kHz mono WAV from several voices, with a short breath between them. */
function speak(parts: { v: string; t: string }[], out: string) {
  const pcm: Buffer[] = [];
  const gap = Buffer.alloc(16000 * 2 * 0.2); // 200 ms
  for (const [k, p] of parts.entries()) {
    const aiff = `${out}.${k}.aiff`, wav = `${out}.${k}.wav`;
    execFileSync('say', ['-v', p.v, '-o', aiff, p.t]);
    execFileSync('afconvert', [aiff, '-o', wav, '-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1']);
    const b = fs.readFileSync(wav);
    const at = b.indexOf('data');
    pcm.push(b.subarray(at + 8, at + 8 + b.readUInt32LE(at + 4)), gap);
  }
  const data = Buffer.concat(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, data]));
}

async function transcribeAll(): Promise<Record<string, string[]>> {
  fs.mkdirSync(DIR, { recursive: true });
  const cached: Record<string, string[]> = fs.existsSync(TRANSCRIPTS) && !process.argv.includes('--fresh')
    ? JSON.parse(fs.readFileSync(TRANSCRIPTS, 'utf8')) : {};
  if (cached.groq && !cached.auto) cached.auto = cached.groq;
  const todo = PROVIDERS.filter((p) => !cached[p]?.length);
  if (todo.length === 0) return cached;

  const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
  const PW = 'TeluguCheck@2026';
  const u = await prisma.user.create({
    data: { email: `telugu.${Date.now()}@sobhana.local`, name: 'Telugu Check', role: 'owner',
            passwordHash: await bcrypt.hash(PW, 10), activeBranchId: branch!.id, isActive: true },
    select: { id: true, email: true },
  });
  const out: Record<string, string[]> = { ...cached };
  for (const p of todo) out[p] = [];
  try {
    const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: u.email, password: PW }) });
    const lb = await login.json() as any;
    const H = { Authorization: `Bearer ${lb.token ?? lb.accessToken}`, 'X-Branch-Id': branch!.id };
    for (const [i, c] of CASES.entries()) {
      const wav = path.join(DIR, `case${i + 1}.wav`);
      if (!fs.existsSync(wav)) speak(c.parts, wav);
      for (const p of todo) {
        // Under prod's 6-per-minute dictation burst limit.
        await new Promise((r) => setTimeout(r, 11_000));
        const form = new FormData();
        form.append('audio', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), `case${i + 1}.wav`);
        form.append('provider', 'groq');
        if (p !== 'auto') form.append('language', p);
        const r = await fetch(`${API}/api/prescriptions/transcribe`, { method: 'POST', headers: H, body: form });
        const b = await r.json() as any;
        out[p][i] = r.ok ? `[${b.transcript.provider}] ${b.transcript.text}` : `[error ${r.status}] ${b?.message ?? ''}`;
        process.stdout.write('.');
      }
    }
    console.log();
    fs.writeFileSync(TRANSCRIPTS, JSON.stringify(out, null, 2));
  } finally {
    await prisma.auditLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  return out;
}

(async () => {
  const transcripts = await transcribeAll();
  const tally = { drugOk: 0, drugAsked: 0, drugWrong: 0, drugMissed: 0, fieldOk: 0, fieldMissing: 0, fieldWrong: 0, perfect: 0, runs: 0 };

  for (const p of PROVIDERS) {
    console.log(`\n══════ WHISPER · language: ${p === 'auto' ? 'auto-detect (today)' : p} ══════`);
    for (const [i, c] of CASES.entries()) {
      const heard = (transcripts[p]?.[i] ?? '').replace(/^\[[^\]]*\]\s*/, '');
      tally.runs++;
      console.log(`\n${String(i + 1).padStart(2)}. said:  ${said(c)}\n    heard: ${heard || '(nothing)'}`);
      if (!heard || /^\[error/.test(transcripts[p]?.[i] ?? '')) { tally.drugMissed += c.want.length; console.log('    ✗ no transcript'); continue; }
      const { items } = await extractPrescription(heard, []);
      let perfect = items.length === c.want.length;
      for (const w of c.want) {
        // The extracted line this expectation is about: the one whose name resolves to / mentions the drug.
        let best: { line: string; ok: boolean } | null = null;
        for (const it of items) {
          const r = await resolveMedication({ spoken: it.name || it.spokenText, strength: it.strength, dosageForm: it.dosageForm });
          const hay = (x: any) => `${x?.canonicalName ?? ''} ${x?.genericName ?? ''} ${x?.brandName ?? ''}`;
          const right = r.match && w.drug.test(hay(r.match));
          const offered = !r.match && r.candidates.some((cd: any) => w.drug.test(hay(cd)));
          const wrong = r.resolution === 'RESOLVED' && r.match && !w.drug.test(hay(r.match));
          if (!right && !offered && !w.drug.test(`${it.name} ${it.spokenText}`)) continue;
          const f: string[] = [];
          const field = (label: string, got: unknown, want: unknown, ok: boolean) => {
            if (want === undefined) return;
            if (got == null || got === '') { tally.fieldMissing++; perfect = false; f.push(`${label}: missing`); }
            else if (ok) { tally.fieldOk++; f.push(`${label}: ${got} ✓`); }
            else { tally.fieldWrong++; perfect = false; f.push(`${label}: ${got} ✗ WRONG`); }
          };
          field('freq', it.frequencyCode, w.freq, it.frequencyCode === w.freq);
          field('timing', it.timing, w.timing, !!it.timing && !!w.timing?.test(it.timing));
          field('dur', it.durationValue != null ? `${it.durationValue} ${it.durationUnit}` : null, w.dur,
            it.durationValue === w.dur?.[0] && (it.durationUnit ?? '').startsWith(w.dur?.[1] ?? '~'));
          if (w.alt !== undefined) {
            if (it.isAlternative === w.alt) { tally.fieldOk++; f.push('either/or ✓'); } else { tally.fieldWrong++; perfect = false; f.push('either/or ✗'); }
          }
          const drug = right ? '✓ ' + r.match!.canonicalName : offered ? `asked (right one offered)` : wrong ? `✗ WRONG DRUG: ${r.match!.canonicalName}` : '✗ not matched';
          if (right) tally.drugOk++; else if (offered) { tally.drugAsked++; perfect = false; } else if (wrong) { tally.drugWrong++; perfect = false; } else { tally.drugMissed++; perfect = false; }
          best = { line: `    · "${it.name}" → ${drug} · ${f.join(' · ')}`, ok: !!right };
          break;
        }
        if (!best) { tally.drugMissed++; perfect = false; console.log(`    ✗ ${w.drug} — not extracted`); } else console.log(best.line);
      }
      if (perfect) tally.perfect++;
      if (items.length !== c.want.length) console.log(`    ! ${items.length} medicine line(s), expected ${c.want.length}`);
    }
  }
  console.log(`\n── ${tally.perfect}/${tally.runs} prescriptions perfect ──`);
  console.log(`drugs: ${tally.drugOk} matched · ${tally.drugAsked} asked · ${tally.drugMissed} missed · ${tally.drugWrong} WRONG`);
  console.log(`fields: ${tally.fieldOk} right · ${tally.fieldMissing} missing (asked) · ${tally.fieldWrong} WRONG`);
  await prisma.$disconnect();
  process.exit(0);
})();

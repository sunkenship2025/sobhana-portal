/**
 * REAL Telugu–English speech through the dictation pipeline: the clips and hearings
 * transcribe.py made, then extractPrescription (primary hearing + the second one,
 * as routes/prescriptions.ts hands them over) and resolveMedication, with
 * resolveLine's rule that a repaired name is asked, never matched silently.
 *
 *   npx tsx speech-eval/telugu-real/check.ts --hint    # .cache/asr-hint.txt, before transcribe.py
 *   npx tsx speech-eval/telugu-real/check.ts           # production: 'en' + second hearing 'te6'
 *   TE_PRIMARY=te6 TE_ALSO=en npx tsx speech-eval/telugu-real/check.ts
 *
 * Sep 25 2026, 29 clips / 18 speakers: 'en' alone 34% right drug first, 1/14
 * schedules; 'en' + 'te6' with that day's rules 59%, 4/14; silently wrong 0.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../../src/lib/prisma';
import { extractPrescription } from '../../src/services/voiceRx/extract';
import { resolveMedication, consonantSkeleton, buildAsrHint } from '../../src/services/voiceRx/resolver';
import { transliterateIndic } from '../../src/services/voiceRx/normalize';
import { fitPrompt } from '../../src/services/voiceRx/asr';

const D = path.join(__dirname, '.cache');
const PRIMARY = process.env.TE_PRIMARY ?? 'en';
const ALSO = process.env.TE_ALSO ?? 'te6';
const load = (f: string) => (fs.existsSync(path.join(D, f)) ? JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')) : {});
const man: any[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const primary = load(`transcripts-${PRIMARY}.json`);
const second = ALSO ? load(`transcripts-${ALSO}.json`) : {};
const ITEMS = `items-${PRIMARY}${ALSO ? '+' + ALSO : ''}.json`;
const itemsCache = load(ITEMS);
const lookups = load('lookups.json');

function lev(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
// Precision over recall: Telugu words collide with short brand skeletons
// ("pan" ~ panichestundi, "shelcal" ~ chalikalu). A short name must be the whole
// word (digits allowed: pan40); a longer one within a quarter of its letters.
function says(text: string, name: string): boolean {
  const t = transliterateIndic(text).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const close = (w: string) => {
    const x = w.replace(/\d+$/, '');
    if (x === name) return true;
    const key = consonantSkeleton(name);
    if (key.length >= 5 && consonantSkeleton(x) === key) return true; // saiklopama = cyclopam
    if (name.length < 5 || x[0] !== name[0] || Math.abs(x.length - name.length) > 2) return false;
    return lev(x, name) <= Math.floor(name.length / 4);
  };
  return t.some((w, i) => close(w) || (i + 1 < t.length && close(w + t[i + 1])));
}
async function lookup(spoken: string, strength: string | null, form: string | null) {
  const k = `${spoken}|${strength ?? ''}|${form ?? ''}`;
  if (!lookups[k]) {
    const r = await resolveMedication({ spoken, strength, dosageForm: form });
    lookups[k] = { resolution: r.resolution, match: r.match, candidates: r.candidates.slice(0, 3) };
    fs.writeFileSync(path.join(D, 'lookups.json'), JSON.stringify(lookups));
    await new Promise((res) => setTimeout(res, 300));
  }
  return lookups[k];
}

(async () => {
  if (process.argv.includes('--hint')) {
    fs.mkdirSync(D, { recursive: true });
    fs.writeFileSync(path.join(D, 'asr-hint.txt'), fitPrompt(await buildAsrHint()) ?? '');
    await prisma.$disconnect();
    return;
  }
  const t = { n: 0, heard: 0, onRx: 0, first: 0, asked: 0, wrong: 0, fAnn: 0, fOk: 0 };
  const onlyAnnotated = process.env.TE_ANNOTATED === '1';
  for (const c of man) {
    const h = primary[c.id];
    if (!h) continue;
    if (onlyAnnotated && c.freq === undefined) continue;
    t.n++;
    // Heard: named (in any script), or its sound skeleton begins a word ("ikosprind" ~ ecosprin).
    const sk = consonantSkeleton(c.name);
    const heard = says(h.text, c.name) || (sk.length >= 4 && transliterateIndic(h.text).toLowerCase().split(/[^a-z]+/).some((w) => consonantSkeleton(w).startsWith(sk)));
    if (heard) t.heard++;
    if (!itemsCache[c.id]) {
      const also = ALSO ? second[c.id]?.text : undefined;
      itemsCache[c.id] = (await extractPrescription(h.text, h.segments, { alsoHeard: also })).items;
      fs.writeFileSync(path.join(D, ITEMS), JSON.stringify(itemsCache, null, 1));
    }
    const items: any[] = itemsCache[c.id];
    const re = new RegExp(c.drug, 'i');
    // The line for this drug: named like it, or resolving to it (a "pan" clip says Pantop).
    let line = items.find((it) => says(`${it.name} ${it.spokenText ?? ''}`, c.name) || re.test(it.name));
    for (const it of items) {
      if (line) break;
      const r = await lookup(it.name || it.spokenText, it.strength ?? null, it.dosageForm ?? null);
      const top = r.match ?? r.candidates[0];
      if (top && re.test(`${top.canonicalName} ${top.genericName ?? ''} ${top.brandName ?? ''}`)) line = it;
    }
    let verdict = '✗ no line';
    if (c.freq !== undefined) t.fAnn++;
    if (line) {
      t.onRx++;
      let r = await lookup(line.name || line.spokenText, line.strength ?? null, line.dosageForm ?? null);
      if (line.fieldStates?.name === 'NORMALIZED' && r.resolution === 'RESOLVED' && line.spokenText && line.spokenText !== line.name) {
        const asHeard = await lookup(line.spokenText, line.strength ?? null, line.dosageForm ?? null);
        if (!(asHeard.resolution === 'RESOLVED' && asHeard.match?.medicationId === r.match?.medicationId)) r = { ...r, resolution: 'UNRESOLVED', candidates: [r.match, ...r.candidates], match: null };
      }
      const hay = (x: any) => `${x?.canonicalName ?? ''} ${x?.genericName ?? ''} ${x?.brandName ?? ''}`;
      const top = r.match ?? r.candidates[0];
      if (r.resolution === 'RESOLVED' && r.match && !re.test(hay(r.match))) { t.wrong++; verdict = `✗ WRONG ${r.match.canonicalName}`; }
      else if (top && re.test(hay(top))) { t.first++; if (!r.match) t.asked++; verdict = r.match ? `✓ ${r.match.canonicalName}` : `asked¹ ${top.canonicalName}`; }
      else verdict = `✗ not offered (${top?.canonicalName ?? 'nothing'})`;
      if (c.freq !== undefined) {
        const ok = c.freq.includes(line.frequencyCode);
        if (ok) t.fOk++;
        verdict += ` · freq ${line.frequencyCode ?? '-'}${ok ? ' ✓' : ` ✗ (said ${c.freq.join('/')})`}`;
      }
    }
    if (!process.argv.includes('--quiet')) {
      console.log(`\n${c.id} [${c.channel}]\n  google : ${c.caption.slice(0, 160)}\n  whisper: ${h.text.slice(0, 160)}\n  lines  : ${items.map((i) => `${i.name}${i.strength ? ' ' + i.strength : ''} ${i.frequencyCode ?? ''} ${i.timing ?? ''}`.trim()).join(' · ') || '-'}\n  → ${heard ? 'heard' : 'NOT heard'} · ${verdict}`);
    }
  }
  const p = (a: number, b: number) => `${a}/${b} (${Math.round((100 * a) / Math.max(1, b))}%)`;
  console.log(`\nREAL TELUGU–ENGLISH SPEECH (heard '${PRIMARY}'${ALSO ? ` + second hearing '${ALSO}'` : ''}) · ${t.n} clips, ${new Set(man.filter((c) => primary[c.id]).map((c) => c.channel)).size} speakers (channels)`);
  console.log(`  brand written by the recogniser:  ${p(t.heard, t.n)}`);
  console.log(`  on the prescription:              ${p(t.onRx, t.n)}`);
  console.log(`  right drug matched / offered 1st: ${p(t.first, t.n)}   (asked ${t.asked})`);
  console.log(`  silently WRONG drug:              ${t.wrong}`);
  if (t.fAnn) console.log(`  schedule right, of clips that state one: ${p(t.fOk, t.fAnn)}`);
  await prisma.$disconnect();
  process.exit(0);
})();

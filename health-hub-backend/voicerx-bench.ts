/**
 * VoiceRx benchmark — voice in, prescription out, scored.
 *
 *   npm run voicerx:bench                 # ASR + deterministic layer + resolver
 *   npm run voicerx:bench -- --extract    # adds the LLM extraction step (costs)
 *   npm run voicerx:bench -- --voice Rishi --cases b1,h3
 *
 * Speech is generated with macOS `say` using INDIAN ENGLISH voices (Rishi, Aman,
 * Tara), which is the closest thing to a real doctor available without recording
 * one. It is synthetic and cleaner than a real clinic — no fan, no background,
 * no fast speech — so treat these scores as an OPTIMISTIC ceiling, not a
 * prediction. The honest number needs recordings from real doctors.
 *
 * WHAT IT SCORES, AND WHY NOT "ACCURACY"
 * Per the research, aggregate accuracy hides exactly what matters: term-restricted
 * medical WER ran 7.8-10.3 points above overall WER on jargon-heavy speech. So the
 * score here is per FIELD, and medication identity is reported separately from
 * everything else, because getting the drug wrong and getting the duration wrong
 * are not the same class of event.
 *
 * A case passes on the SYSTEM's output, not the transcript. Recovering from a
 * mis-hearing ("as it real" -> Azithromycin) is a pass — recovering is the point.
 */
import { execFileSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { transcribeWithFallback } from './src/services/voiceRx/asr';
import { buildAsrHint, resolveMedication } from './src/services/voiceRx/resolver';
import { extractPrescription } from './src/services/voiceRx/extract';
import { screenTelemedicineProhibited } from './src/services/voiceRx/controlled';
import { wordsToNumbers, parseFrequency, parseTiming, parseDuration, parseStrength } from './src/services/voiceRx/normalize';
import { BENCH, type BenchCase } from './voicerx-bench-data';
import prisma from './src/lib/prisma';

const AUDIO_DIR = '/tmp/voicerx-bench';
const arg = (f: string) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : undefined; };
const VOICE = arg('--voice') ?? 'Rishi';
const ONLY = arg('--cases')?.split(',');
const DO_EXTRACT = process.argv.includes('--extract');

interface Score { field: string; pass: number; total: number }

function speak(c: BenchCase, voice: string): string {
  if (!existsSync(AUDIO_DIR)) mkdirSync(AUDIO_DIR, { recursive: true });
  const path = `${AUDIO_DIR}/${voice}-${c.id}.m4a`;
  if (!existsSync(path)) {
    execFileSync('say', ['-v', voice, '-o', path, '--data-format=aac', c.spoken]);
  }
  return path;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Days, from whatever unit was parsed. */
function toDays(v: number | null, u: string | null): number | null {
  if (v == null) return null;
  return u === 'weeks' ? v * 7 : u === 'months' ? v * 30 : v;
}

(async () => {
  const cases = BENCH.filter((c) => !ONLY || ONLY.includes(c.id));
  const hint = await buildAsrHint();
  console.log(`VoiceRx benchmark · ${cases.length} cases · voice "${VOICE}" · hint ${hint.length} chars`);
  console.log(`extraction: ${DO_EXTRACT ? 'ON (LLM)' : 'OFF (deterministic layer only)'}\n`);

  const scores: Record<string, Score> = {};
  const bump = (field: string, ok: boolean) => {
    scores[field] ??= { field, pass: 0, total: 0 };
    scores[field].total++;
    if (ok) scores[field].pass++;
  };
  const byCategory: Record<string, { pass: number; total: number }> = {};
  const failures: string[] = [];

  // Groq's free tier is 20 requests/minute. The adapter retries a 429, but pacing
  // here keeps the run from spending its time asleep.
  const PACE_MS = Number(arg('--pace') ?? 3200);
  let lastCall = 0;

  for (const c of cases) {
    const since = Date.now() - lastCall;
    if (lastCall && since < PACE_MS) await new Promise((r) => setTimeout(r, PACE_MS - since));
    lastCall = Date.now();
    const audio = speak(c, VOICE);
    let heard = '';
    try {
      const t = await transcribeWithFallback(readFileSync(audio), `${c.id}.m4a`, { provider: 'groq', prompt: hint });
      heard = t.text;
    } catch (e) {
      failures.push(`${c.id} ASR FAILED: ${(e as Error).message.slice(0, 90)}`);
      continue;
    }

    // The deterministic layer runs on the heard text regardless of the LLM.
    const normed = wordsToNumbers(heard);
    let name = normed;
    let strength = parseStrength(normed)?.strength ?? null;
    let freq: string | null = parseFrequency(heard);
    let timing: string | null = parseTiming(heard);
    const dur = parseDuration(heard);
    let durationDays = toDays(dur?.value ?? null, dur?.unit ?? null);
    let itemCount = 1;

    if (DO_EXTRACT) {
      try {
        const ex = await extractPrescription(heard, []);
        itemCount = ex.items.length;
        const first = ex.items[0];
        if (first) {
          name = first.name;
          strength = first.strength ?? strength;
          freq = first.frequencyCode ?? freq;
          timing = first.timing ?? timing;
          durationDays = toDays(first.durationValue, first.durationUnit) ?? durationDays;
        }
      } catch (e) {
        failures.push(`${c.id} EXTRACT FAILED: ${(e as Error).message.slice(0, 90)}`);
      }
    }

    const res = await resolveMedication({ spoken: name, strength });
    const resolvedName = res.match?.canonicalName ?? '';

    // --- score ---------------------------------------------------------------
    const want = c.expect;
    let casePass = true;
    const mark = (field: string, ok: boolean, detail?: string) => {
      bump(field, ok);
      if (!ok) { casePass = false; failures.push(`${c.id} [${field}] ${detail ?? ''}`); }
    };

    if (want.medication === null) {
      mark('medication', res.resolution !== 'RESOLVED', `expected NO match, got "${resolvedName}"`);
    } else {
      mark('medication', norm(resolvedName).includes(norm(want.medication)),
        `want ~"${want.medication}", got "${resolvedName || res.resolution}" (heard: "${heard.slice(0, 60)}")`);
    }

    if (want.strength !== undefined) {
      mark('strength', want.strength === null ? strength === null : norm(strength) === norm(want.strength),
        `want ${want.strength}, got ${strength}`);
    }
    if (want.frequency !== undefined) {
      mark('frequency', want.frequency === null ? freq === null : freq === want.frequency,
        `want ${want.frequency}, got ${freq}`);
    }
    if (want.timing !== undefined) {
      mark('timing', want.timing === null ? timing === null : timing === want.timing,
        `want ${want.timing}, got ${timing}`);
    }
    if (want.durationDays !== undefined) {
      mark('duration', want.durationDays === null ? durationDays === null : durationDays === want.durationDays,
        `want ${want.durationDays}, got ${durationDays}`);
    }
    if (want.blocksTelemedicine) {
      mark('controlled-block', screenTelemedicineProhibited(`${heard} ${resolvedName}`).length > 0,
        `expected a §3.7.4 block, heard "${heard.slice(0, 60)}"`);
    }
    if (want.count !== undefined && DO_EXTRACT) {
      mark('multi-drug', itemCount === want.count, `want ${want.count} medicines, got ${itemCount}`);
    }

    byCategory[c.category] ??= { pass: 0, total: 0 };
    byCategory[c.category].total++;
    if (casePass) byCategory[c.category].pass++;

    process.stdout.write(casePass ? '.' : 'F');
  }

  // --- report ----------------------------------------------------------------
  console.log('\n\nBY FIELD');
  for (const s of Object.values(scores)) {
    const pct = Math.round((s.pass / s.total) * 100);
    console.log(`  ${s.field.padEnd(18)} ${String(s.pass).padStart(3)}/${String(s.total).padEnd(3)}  ${String(pct).padStart(3)}%`);
  }

  console.log('\nBY CATEGORY (whole case must pass)');
  for (const [k, v] of Object.entries(byCategory).sort()) {
    const pct = Math.round((v.pass / v.total) * 100);
    console.log(`  ${k.padEnd(18)} ${String(v.pass).padStart(3)}/${String(v.total).padEnd(3)}  ${String(pct).padStart(3)}%`);
  }

  if (failures.length) {
    console.log(`\nFAILURES (${failures.length})`);
    for (const f of failures) console.log(`  ${f}`);
  }

  const totalCases = Object.values(byCategory).reduce((a, b) => a + b.total, 0);
  const passCases = Object.values(byCategory).reduce((a, b) => a + b.pass, 0);
  console.log(`\n${passCases}/${totalCases} cases fully clean.`);
  console.log('Synthetic TTS in a quiet room — an optimistic ceiling, not a prediction.');
  await prisma.$disconnect();
})();

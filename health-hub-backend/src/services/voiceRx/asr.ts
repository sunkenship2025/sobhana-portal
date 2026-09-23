/**
 * Speech recognition — one interface, two providers, chosen by env.
 *
 * WHY AN ADAPTER AND NOT A DIRECT CALL
 * The research was blunt: published WER does not transfer to Indian clinical
 * speech. In-domain adaptation moved a Hinglish clinical system 25.73 -> 19.61
 * tcpWER while ~1,800h of GENERIC Hindi bought 1.93 points, and a 600M model beat
 * one three times its size zero-shot. So no vendor's benchmark tells us who wins
 * here — only our own audio does. This file exists so swapping providers is a
 * config change and a benchmark run, not a rewrite.
 *
 * WHICH TO USE
 *   groq   — whisper-large-v3-turbo, ~$0.04/hr. ~8x cheaper than Sarvam. Start here.
 *   sarvam — Saarika, Rs 30/hr, India-hosted, and the ONLY provider that names
 *            Hindi-English code-switching as a feature (a `codemix` output mode)
 *            rather than just listing Hindi as a language.
 *
 * The price gap at clinic volume is ~Rs 200/month. If Sarvam's codemix measurably
 * hears drug names better in Hinglish, it wins on that alone — but measure it,
 * do not assume it.
 */
import { logger } from '../../lib/logger';

/** One timed chunk of speech. Timings are what make "view source" real. */
export interface TranscriptSegment {
  text: string;
  /** Seconds from start of audio. */
  start: number;
  end: number;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  provider: string;
  model: string;
  durationSec: number | null;
}

export interface SpeechRecognizer {
  readonly name: string;
  readonly model: string;
  transcribe(audio: Buffer, filename: string, opts?: TranscribeOptions): Promise<Transcript>;
}

export interface TranscribeOptions {
  /**
   * A biasing hint. Both providers accept one, and for us it carries the clinic's
   * common drug names — the cheapest accuracy win available, because an ASR that
   * has "Augmentin" in its prompt is far likelier to emit it than "all mentum".
   */
  prompt?: string;
  /**
   * Leave UNSET for code-switched speech. Pinning language=hi on a sentence that
   * opens in English makes the decoder fight the audio; auto-detect handles the
   * Hinglish case better in practice.
   */
  language?: string;
}

export class AsrUnavailable extends Error {}

const TIMEOUT_MS = Number(process.env.VOICE_RX_ASR_TIMEOUT_MS || 60_000);

/** Shared fetch with a hard timeout — a hung ASR must not hold a doctor's screen. */
async function postForm(url: string, headers: Record<string, string>, form: FormData): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: form, signal: ctrl.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new AsrUnavailable(`${res.status} ${body.slice(0, 300)}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new AsrUnavailable(`Non-JSON response: ${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new AsrUnavailable(`Timed out after ${TIMEOUT_MS}ms`);
    if (err instanceof AsrUnavailable) throw err;
    throw new AsrUnavailable(err?.message || 'ASR request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Groq — OpenAI-compatible /audio/transcriptions serving whisper-large-v3-turbo.
 *
 * `verbose_json` + `segment` granularity is what yields per-segment timings. Ask
 * for word granularity and you pay for detail no part of this pipeline uses.
 */
class GroqRecognizer implements SpeechRecognizer {
  readonly name = 'groq';
  readonly model = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';

  async transcribe(audio: Buffer, filename: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new AsrUnavailable('GROQ_API_KEY not set');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    // Temperature 0: this is transcription, not composition. Any sampling here is
    // a chance to invent a drug name that was never said.
    form.append('temperature', '0');
    if (opts.prompt) form.append('prompt', opts.prompt);
    if (opts.language) form.append('language', opts.language);

    const json = await postForm(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      { Authorization: `Bearer ${key}` },
      form,
    );

    const segments: TranscriptSegment[] = Array.isArray(json.segments)
      ? json.segments.map((s: any) => ({
          text: String(s.text ?? '').trim(),
          start: Number(s.start ?? 0),
          end: Number(s.end ?? 0),
        }))
      : [];

    return {
      text: String(json.text ?? '').trim(),
      segments,
      language: json.language ?? null,
      provider: this.name,
      model: this.model,
      durationSec: json.duration != null ? Number(json.duration) : null,
    };
  }
}

/**
 * Sarvam — Saarika speech-to-text.
 *
 * `language_code: 'unknown'` asks Saarika to auto-detect, which is the right
 * default for code-switched dictation for the same reason it is on Groq.
 *
 * Sarvam's response shape is flatter than Whisper's: there is a transcript and,
 * depending on the endpoint and plan, optional timestamps. When timings are
 * absent we synthesise ONE segment spanning the whole clip rather than faking
 * per-phrase boundaries — a wrong timestamp is worse than an honest coarse one,
 * because the entire point of source-linking is that the doctor can trust it.
 */
class SarvamRecognizer implements SpeechRecognizer {
  readonly name = 'sarvam';
  readonly model = process.env.SARVAM_STT_MODEL || 'saarika:v2.5';

  async transcribe(audio: Buffer, filename: string, opts: TranscribeOptions = {}): Promise<Transcript> {
    const key = process.env.SARVAM_API_KEY;
    if (!key) throw new AsrUnavailable('SARVAM_API_KEY not set');

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', this.model);
    form.append('language_code', opts.language || 'unknown');
    form.append('with_timestamps', 'true');

    const json = await postForm(
      'https://api.sarvam.ai/speech-to-text',
      { 'api-subscription-key': key },
      form,
    );

    const text = String(json.transcript ?? json.text ?? '').trim();

    let segments: TranscriptSegment[] = [];
    const ts = json.timestamps;
    if (ts && Array.isArray(ts.words) && Array.isArray(ts.start_time_seconds)) {
      // Word-level timings: group into ~8-word segments so the UI has something
      // clickable rather than 200 one-word spans.
      const words: string[] = ts.words;
      const starts: number[] = ts.start_time_seconds;
      const ends: number[] = ts.end_time_seconds ?? [];
      const GROUP = 8;
      for (let i = 0; i < words.length; i += GROUP) {
        const slice = words.slice(i, i + GROUP);
        segments.push({
          text: slice.join(' ').trim(),
          start: Number(starts[i] ?? 0),
          end: Number(ends[Math.min(i + GROUP, words.length) - 1] ?? starts[i] ?? 0),
        });
      }
    }
    if (segments.length === 0 && text) {
      segments = [{ text, start: 0, end: Number(json.duration ?? 0) }];
    }

    return {
      text,
      segments,
      language: json.language_code ?? null,
      provider: this.name,
      model: this.model,
      durationSec: json.duration != null ? Number(json.duration) : null,
    };
  }
}

const RECOGNIZERS: Record<string, () => SpeechRecognizer> = {
  groq: () => new GroqRecognizer(),
  sarvam: () => new SarvamRecognizer(),
};

/** Default provider. Groq first: ~8x cheaper, and we benchmark before we spend. */
export function defaultProviderName(): string {
  const want = (process.env.VOICE_RX_ASR_PROVIDER || 'groq').toLowerCase();
  return RECOGNIZERS[want] ? want : 'groq';
}

export function getRecognizer(provider?: string): SpeechRecognizer {
  const name = (provider || defaultProviderName()).toLowerCase();
  const make = RECOGNIZERS[name];
  if (!make) throw new AsrUnavailable(`Unknown ASR provider "${name}"`);
  return make();
}

export function availableProviders(): { name: string; configured: boolean; model: string }[] {
  return [
    { name: 'groq', configured: !!process.env.GROQ_API_KEY, model: process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo' },
    { name: 'sarvam', configured: !!process.env.SARVAM_API_KEY, model: process.env.SARVAM_STT_MODEL || 'saarika:v2.5' },
  ];
}

/**
 * Transcribe with a fallback to the other provider.
 *
 * A doctor mid-consultation does not care which vendor is down. If the preferred
 * provider fails and the other is configured, use it and SAY SO in the returned
 * transcript — the prescription records which engine heard it, because that is
 * evidence, and because a benchmark that cannot tell the two apart is useless.
 */
export async function transcribeWithFallback(
  audio: Buffer,
  filename: string,
  opts: TranscribeOptions & { provider?: string } = {},
): Promise<Transcript> {
  const preferred = (opts.provider || defaultProviderName()).toLowerCase();
  const order = [preferred, ...Object.keys(RECOGNIZERS).filter((p) => p !== preferred)];

  let lastErr: Error | null = null;
  for (const name of order) {
    const rec = getRecognizer(name);
    const configured = availableProviders().find((p) => p.name === name)?.configured;
    if (!configured) continue;
    try {
      const t = await rec.transcribe(audio, filename, opts);
      if (name !== preferred) {
        logger.warn({ preferred, used: name }, 'voiceRx: ASR fell back to secondary provider');
      }
      return t;
    } catch (err: any) {
      lastErr = err;
      logger.error({ err, provider: name }, 'voiceRx: ASR provider failed');
    }
  }
  throw new AsrUnavailable(
    lastErr ? `All ASR providers failed. Last: ${lastErr.message}` : 'No ASR provider is configured',
  );
}

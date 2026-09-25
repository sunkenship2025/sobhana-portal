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
import { isLooping } from './normalize';

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

/**
 * Groq rejects a prompt over 896 characters with a 400. Sarvam has no documented
 * cap, but the same budget is a sane default: a hint that is mostly long-tail
 * names biases nothing anyway.
 */
export const MAX_ASR_PROMPT_CHARS = 880;

/**
 * Trim a biasing hint to fit, cutting at a comma so a medicine name is never
 * half-sent. Belt and braces — buildAsrHint already budgets — because a hint
 * from anywhere else would otherwise fail the whole transcription.
 */
export function fitPrompt(prompt: string | undefined, max = MAX_ASR_PROMPT_CHARS): string | undefined {
  if (!prompt || prompt.length <= max) return prompt;
  const cut = prompt.slice(0, max);
  const lastComma = cut.lastIndexOf(',');
  return (lastComma > max * 0.5 ? cut.slice(0, lastComma) : cut).trim();
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
  /** Override the provider's model for this call (Groq: the two Whisper sizes). */
  model?: string;
  /**
   * What the doctor speaks — "te" (Telugu + English), "hi" (Hindi + English),
   * "en". Each recogniser maps it to whatever reads that speech best; an explicit
   * `language` wins over it.
   */
  speech?: 'te' | 'hi' | 'en';
}

/**
 * Whisper, measured on spoken Telugu–English and Hindi–English prescriptions
 * (mixed-dictation-check.ts): told "en", it spells the brands best. On synthetic
 * voices "te" wrote the wrong scripts; on REAL Telugu speakers "te" is faithful
 * but "en" translates and can loop — so Telugu gets a second hearing in "te"
 * (routes/prescriptions.ts). Hindi reads best detected.
 */
const WHISPER_LANGUAGE: Record<'te' | 'hi' | 'en', string | undefined> = { te: 'en', hi: undefined, en: 'en' };

export class AsrUnavailable extends Error {}

/** Thrown only while retrying; never escapes a recognizer. */
class RateLimited extends Error {
  constructor(public retryAfterMs: number, message: string) { super(message); }
}

/**
 * Groq's free tier allows 20 requests per minute. Two doctors dictating in the
 * same minute is not a hypothetical in a clinic, and without this a 429 surfaced
 * to the doctor as "speech recognition is unavailable" — for a limit that clears
 * in three seconds. Groq states the wait in its own error text, so honour it.
 */
const RETRY_ATTEMPTS = Number(process.env.VOICE_RX_ASR_RETRIES || 3);

function parseRetryAfter(body: string, header: string | null): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 20_000);
  }
  // "Please try again in 3s" / "in 1.5s"
  const m = body.match(/try again in ([\d.]+)s/i);
  if (m) return Math.min(Number(m[1]) * 1000 + 250, 20_000);
  return 3_000;
}

const TIMEOUT_MS = Number(process.env.VOICE_RX_ASR_TIMEOUT_MS || 60_000);

/** Shared fetch with a hard timeout — a hung ASR must not hold a doctor's screen. */
async function postForm(url: string, headers: Record<string, string>, form: FormData): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: form, signal: ctrl.signal });
    const body = await res.text();
    if (res.status === 429) {
      throw new RateLimited(parseRetryAfter(body, res.headers.get('retry-after')), body.slice(0, 200));
    }
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
    if (err instanceof AsrUnavailable || err instanceof RateLimited) throw err;
    throw new AsrUnavailable(err?.message || 'ASR request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * postForm, but waits out a rate limit instead of failing the doctor.
 *
 * A retry here is safe: transcription is idempotent and nothing has been written
 * yet. Bounded attempts, because a doctor waiting indefinitely is its own
 * failure — past the budget it raises and the typed editor takes over.
 */
async function postFormWithRetry(url: string, headers: Record<string, string>, makeForm: () => FormData): Promise<any> {
  let lastMessage = '';
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await postForm(url, headers, makeForm());
    } catch (err) {
      if (!(err instanceof RateLimited) || attempt === RETRY_ATTEMPTS) {
        if (err instanceof RateLimited) {
          throw new AsrUnavailable(`Rate limited after ${RETRY_ATTEMPTS + 1} attempts: ${err.message}`);
        }
        throw err;
      }
      lastMessage = err.message;
      logger.warn({ waitMs: err.retryAfterMs, attempt: attempt + 1 }, 'voiceRx: ASR rate limited, waiting');
      await new Promise((r) => setTimeout(r, err.retryAfterMs));
    }
  }
  throw new AsrUnavailable(lastMessage || 'ASR rate limited');
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

    const makeForm = (temperature = 0) => () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', opts.model || this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    // Temperature 0: this is transcription, not composition. Any sampling here is
    // a chance to invent a drug name that was never said — except below, on a
    // hearing that already came back as a loop.
    form.append('temperature', String(temperature));
    // Groq 400s on a prompt over 896 chars. Discovered the only way it could be:
    // calling the real API with a real key. Every dictation would have failed.
    const prompt = fitPrompt(opts.prompt);
    if (prompt) form.append('prompt', prompt);
    const language = opts.language ?? (opts.speech ? WHISPER_LANGUAGE[opts.speech] : undefined);
    if (language) form.append('language', language);
    return form;
    };

    const post = (temperature?: number) => postFormWithRetry(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      { Authorization: `Bearer ${key}` },
      makeForm(temperature),
    );
    let json = await post();
    // A loop at temperature 0 ("Working Working Working…") is Whisper stuck on
    // noise or music, and it lost the medicine. Whisper's own remedy: decode once
    // more with a little randomness, and keep it if it is not a loop. On real
    // Telugu speech that turned "the first topic is the first topic is…" into
    // "this Monotel 10 mg tablet is given to asthma patients" (3 of 5 loops).
    if (isLooping(String(json.text ?? ''))) {
      const again = await post(0.4).catch(() => null);
      if (again && !isLooping(String(again.text ?? ''))) json = again;
    }

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
      model: opts.model || this.model,
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

    const makeForm = () => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)]), filename);
      form.append('model', this.model);
      // Saarika wants a locale ('te-IN'); callers pass the bare code ('te').
      const lang = opts.language ?? opts.speech;
      form.append('language_code', lang ? `${lang}-IN` : 'unknown');
      const hint = fitPrompt(opts.prompt);
      if (hint) form.append('prompt', hint);
      form.append('with_timestamps', 'true');
      return form;
    };

    const json = await postFormWithRetry(
      'https://api.sarvam.ai/speech-to-text',
      { 'api-subscription-key': key },
      makeForm,
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

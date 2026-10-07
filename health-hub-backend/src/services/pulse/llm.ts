/**
 * Pulse — model client. Same key/base as Smart Reports, different system prompts.
 * DeepSeek V4 Flash with thinking DISABLED: measured on this workload, thinking cost 6
 * questions and ~45s per call for nothing. JSON object output, one retry on parse failure.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { parseLoose, LlmUnavailable } from '../smartReport/llm';

/** The owner's request, as an abort signal every model call in the turn can see. Closing the
 *  panel used to leave the investigation running to the end — up to 33 calls on an answer nobody
 *  would read. Ambient rather than threaded through a dozen signatures. */
export const turnSignal = new AsyncLocalStorage<AbortSignal>();

/** The last thing the model account told us. A 402 is known the moment it happens; the panel
 *  should not have to wait for someone to ask a question to find out. */
let lastFailure: { at: number; why: string } | null = null;
let lastOk = 0;
let balance: { at: number; usd: number | null } | null = null;

/** Is the model reachable, and how much is left. The balance call is free on DeepSeek; on any other
 *  base it is skipped and only the last call's outcome counts. Cached ten minutes. */
export async function modelStatus(): Promise<{ ok: boolean; usd: number | null; why?: string }> {
  if (!API_KEY) return { ok: false, usd: null, why: 'no model key is configured' };
  if (/deepseek\.com/.test(BASE_URL) && (!balance || Date.now() - balance.at > 600_000)) {
    try {
      const r = await fetch(`${BASE_URL}/user/balance`, { headers: { authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(5000) });
      const j: any = r.ok ? await r.json() : null;
      const usd = j?.balance_infos?.find((b: any) => b.currency === 'USD')?.total_balance;
      balance = { at: Date.now(), usd: usd != null ? Number(usd) : null };
      if (j?.is_available === false) lastFailure = { at: Date.now(), why: 'the model account is out of credit' };
      else if (j?.is_available) lastOk = Date.now();   // topped up: clear a past 402 without waiting for a question
    } catch { balance = { at: Date.now(), usd: balance?.usd ?? null }; }
  }
  const failing = !!lastFailure && lastFailure.at > lastOk;
  if (failing) console.warn('[pulse] model unavailable:', lastFailure!.why);
  return { ok: !failing, usd: balance?.usd ?? null, ...(failing ? { why: lastFailure!.why } : {}) };
}

const BASE_URL = (process.env.SMART_REPORT_LLM_BASE_URL || process.env.GO_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const API_KEY = process.env.SMART_REPORT_LLM_API_KEY || process.env.OPENCODE_API_KEY || process.env.GO_API_KEY || process.env.OPENCODE_GO_API_KEY || '';
const MODEL = process.env.PULSE_LLM_MODEL || 'deepseek-v4-flash';

export interface LlmOpts { maxTokens?: number; temperature?: number; bustCache?: boolean; timeoutMs?: number; }

/** Last-ditch extraction: the first balanced {...} in the text. The shared parser is strict and
 *  throws on trailing prose after a valid object, which drops the whole turn to V1 — and V1 does
 *  not know what the question was about, so it answers a different one with full confidence.
 *  Scoped to Pulse; smartReport's parser is left alone. */
function firstObject(raw: string): any {
  const t = String(raw || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

export async function llmJson<T = any>(system: string, user: string, opts: LlmOpts = {}): Promise<T> {
  if (!API_KEY) throw new LlmUnavailable('LLM API key not set');
  const outer = turnSignal.getStore();
  if (outer?.aborted) throw new LlmUnavailable('cancelled by the owner');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  const stop = () => ctrl.abort();
  outer?.addEventListener('abort', stop, { once: true });
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 900,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        messages: [
          // a nonce defeats the prefix cache when we WANT an independent second sample
          { role: 'system', content: (opts.bustCache ? `/* ${Math.random().toString(36).slice(2)} */\n` : '') + system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      const why = `LLM responded ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 401 || res.status === 402) { lastFailure = { at: Date.now(), why: res.status === 402 ? 'the model account is out of credit' : 'the model key was rejected' }; balance = null; }
      throw new LlmUnavailable(why);
    }
    lastOk = Date.now();
    const body: any = await res.json();
    const raw: string = body?.choices?.[0]?.message?.content ?? '';
    const parsed = parseLoose(raw) ?? firstObject(raw);
    if (!parsed || typeof parsed !== 'object') throw new LlmUnavailable('model returned no JSON object');
    return parsed as T;
  } finally { clearTimeout(timer); outer?.removeEventListener('abort', stop); }
}

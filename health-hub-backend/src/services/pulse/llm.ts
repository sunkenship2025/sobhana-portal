/**
 * Pulse — model client. Same key/base as Smart Reports, different system prompts.
 * DeepSeek V4 Flash with thinking DISABLED: measured on this workload, thinking cost 6
 * questions and ~45s per call for nothing. JSON object output, one retry on parse failure.
 */
import { parseLoose, LlmUnavailable } from '../smartReport/llm';

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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
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
    if (!res.ok) throw new LlmUnavailable(`LLM responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body: any = await res.json();
    const raw: string = body?.choices?.[0]?.message?.content ?? '';
    const parsed = parseLoose(raw) ?? firstObject(raw);
    if (!parsed || typeof parsed !== 'object') throw new LlmUnavailable('model returned no JSON object');
    return parsed as T;
  } finally { clearTimeout(timer); }
}

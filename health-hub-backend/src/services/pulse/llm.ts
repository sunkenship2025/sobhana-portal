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
    const parsed = parseLoose(raw);
    if (!parsed || typeof parsed !== 'object') throw new LlmUnavailable('model returned no JSON object');
    return parsed as T;
  } finally { clearTimeout(timer); }
}

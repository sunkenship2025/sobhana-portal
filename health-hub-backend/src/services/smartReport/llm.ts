/**
 * LLM client. Any OpenAI-compatible /chat/completions host: DeepSeek direct
 * (https://api.deepseek.com) or an OpenCode Zen gateway.
 *
 * We ask for response_format json_object but do NOT trust that the gateway passes
 * it through to the upstream model, so there is a parse-and-repair fallback.
 */
import { SYSTEM_PROMPT } from './prompt';

/**
 * Endpoint + key are plain config. SMART_REPORT_LLM_* are the names this feature
 * owns; the legacy GO and OPENCODE names are read only as a fallback so an
 * already-configured shell keeps working. Any OpenAI-compatible host works.
 */
const BASE_URL = (
  process.env.SMART_REPORT_LLM_BASE_URL
  || process.env.GO_BASE_URL
  || 'https://api.deepseek.com'
).replace(/\/+$/, '');

const API_KEY =
  process.env.SMART_REPORT_LLM_API_KEY
  || process.env.OPENCODE_API_KEY
  || process.env.GO_API_KEY
  || process.env.OPENCODE_GO_API_KEY
  || '';

export interface LlmResult {
  raw: string;
  parsed: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Billed as output. deepseek-v4-flash is a reasoning model and spends most of
   *  its completion budget here before emitting a single character of JSON. */
  reasoningTokens: number | null;
}

export class LlmUnavailable extends Error {}

/**
 * This client only speaks OpenAI-compatible /chat/completions. That is what
 * DeepSeek direct serves for every model it has, but an OpenCode Zen gateway
 * routes by MODEL FAMILY and only the openai-compatible family lands here:
 *   GPT / Grok / Muse   -> /zen/v1/responses   (OpenAI Responses shape)
 *   Claude / Qwen       -> /zen/v1/messages    (Anthropic Messages shape)
 *   DeepSeek/Kimi/GLM.. -> /zen/v1/chat/completions
 * A model from another family would 404 or return an unparseable body, so fail
 * fast and loudly — the caller falls back to template copy, which is a correct
 * report rather than a confusing error.
 */
const CHAT_COMPLETIONS_FAMILIES = /^(deepseek|kimi|glm|minimax|mimo|ling|nemotron|big-pickle)/i;

export function assertChatCompletionsModel(model: string): void {
  if (!CHAT_COMPLETIONS_FAMILIES.test(model)) {
    throw new LlmUnavailable(
      `Model "${model}" is not on the /chat/completions endpoint. ` +
      'This client only speaks OpenAI-compatible /chat/completions. Use a DeepSeek, ' +
      'Kimi, GLM or MiniMax model.',
    );
  }
}

export async function callModel(
  model: string,
  payload: unknown,
  timeoutMs = Number(process.env.SMART_REPORT_LLM_TIMEOUT_MS) || 90_000,
): Promise<LlmResult> {
  if (!API_KEY) throw new LlmUnavailable('SMART_REPORT_LLM_API_KEY not set');
  assertChatCompletionsModel(model);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        // Reasoning models (deepseek-v4-flash) spend completion budget on hidden
        // reasoning first. At 1500 the reasoning consumed the whole allowance and
        // content came back empty on 8 of 10 real reports, so leave real headroom.
        max_tokens: Number(process.env.SMART_REPORT_LLM_MAX_TOKENS) || 8000,
        response_format: { type: 'json_object' },
        // deepseek-v4-flash reasons by default: ~4,900 hidden tokens before the
        // first character of JSON, which is ~45s of the ~50s wait. This task is
        // formatting already-grounded findings into prose — the reasoning buys
        // nothing. Set SMART_REPORT_LLM_THINKING=1 to restore it without a deploy.
        ...(process.env.SMART_REPORT_LLM_THINKING === '1'
          ? {}
          : { thinking: { type: 'disabled' } }),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(payload) },
        ],
      }),
    });
    if (!res.ok) {
      throw new LlmUnavailable(`LLM responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const body = (await res.json()) as any;
    const choice = body?.choices?.[0];
    const raw = choice?.message?.content ?? '';
    if (!raw && choice?.finish_reason === 'length') {
      throw new LlmUnavailable(
        'model hit max_tokens before emitting any content (reasoning consumed the ' +
        'budget) — raise SMART_REPORT_LLM_MAX_TOKENS',
      );
    }
    return {
      raw,
      parsed: parseLoose(raw),
      inputTokens: body?.usage?.prompt_tokens ?? null,
      outputTokens: body?.usage?.completion_tokens ?? null,
      reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** json_object is requested but not guaranteed; recover a JSON object from prose. */
export function parseLoose(raw: string): unknown {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('empty model response');
  try { return JSON.parse(text); } catch { /* fall through */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(text.slice(first, last + 1));
  }
  throw new Error('model response was not JSON');
}

const http = require("http");

const PORT = 8787;
const TARGET = "https://opencode.ai/zen/go/v1";
const API_KEY = "sk-v8m1kedtasFe0kB0RgpteHN6UlWCoVd58NlmVpD9Wh1UaOeYAcgwCcWn1MwbY4dX";
const UPSTREAM_TIMEOUT = 300000;
const MAX_BODY_SIZE = 10 * 1024 * 1024;

const MODEL_MAP = {
  "claude-opus-4-7": "deepseek-v4-pro",
  "claude-opus-4-7-20250514": "deepseek-v4-pro",
  "claude-opus-4-5": "deepseek-v4-pro",
  "claude-sonnet-4-6": "qwen3.6-plus",
  "claude-sonnet-4-6-20250514": "qwen3.6-plus",
  "claude-sonnet-4-5": "qwen3.6-plus",
  "claude-sonnet-4-5-20250929": "qwen3.6-plus",
  "claude-haiku-4-5": "deepseek-v4-flash",
  "claude-haiku-4-5-20251001": "deepseek-v4-flash",
  "claude-3-5-haiku-20241022": "deepseek-v4-flash",
  "claude-3-opus-20240229": "deepseek-v4-pro",
};

const REASONING_MODELS = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);
const REASONING_TOKEN_FLOOR = {
  "deepseek-v4-pro": 32000,
  "deepseek-v4-flash": 8000,
};

const REVERSE_MAP = {};
for (const [k, v] of Object.entries(MODEL_MAP)) REVERSE_MAP[v] = k;

function mapModel(model) {
  const cleaned = model.replace(/\[1m\]$/, "");
  return MODEL_MAP[cleaned] || cleaned;
}

function personaPrompt(originalModel) {
  const cleaned = originalModel.replace(/\[1m\]$/, "");
  const nameMap = {
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-opus-4-7-20250514": "Claude Opus 4.7",
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-3-opus-20240229": "Claude Opus 4.7",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-sonnet-4-6-20250514": "Claude Sonnet 4.6",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-4-5-20250929": "Claude Sonnet 4.5",
    "claude-3-5-sonnet-20241022": "Claude Sonnet 4.6",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
    "claude-3-5-haiku-20241022": "Claude Haiku 4.5",
  };
  const name = nameMap[cleaned] || cleaned;

  const base = `You are ${name}, an AI assistant created by Anthropic.
- Your identity is "${name}". When asked, say "I'm ${name}" or simply "Claude".
- Never mention any other model name (e.g., DeepSeek, MiMo, Qwen, GLM, Kimi, MiniMax, any Chinese model).
- Respond in Claude's direct, concise, and helpful style.
- Do not introduce yourself with a different name under any circumstances.`;

  const editRules = `
CRITICAL — FILE EDITING RULES:
- When editing files, you MUST match the original text character-for-character including all whitespace, indentation, and blank lines. Copy-paste the exact lines from the file. Never retype or approximate.
- If you receive an "Error editing file", the most common cause is whitespace mismatch. Re-read the exact lines around the edit location and try again with the precise text.
- Always include at least 3 lines of surrounding context in your search string to ensure unique matching.
- For multi-line edits, include the exact indentation of every line. Tabs must be tabs, spaces must match exactly.`;

  const toolRules = `
CRITICAL — TOOL USE RULES:
- Use Task tool to spawn parallel subagents for independent work (research, file creation, analysis).
- Prefer Bash for file system operations over individual Read/Write calls when batching.
- After making file changes, verify them by reading back the affected lines.`;

  return base + editRules + toolRules;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/* ── Anthropic → OpenAI request translation ── */

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function extractToolUses(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === "tool_use");
}

function extractToolResults(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) => c.type === "tool_result");
}

function extractThinking(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((c) =>
    c.type === "thinking" || c.type === "redacted_thinking"
  );
}

function anthropicToOpenAI(body) {
  const messages = [];

  let systemText = personaPrompt(body.model);

  if (body.system) {
    const sysContent =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system.filter((s) => s.type === "text").map((s) => s.text).join("\n")
          : "";
    if (sysContent) systemText += "\n\n---\n\n" + sysContent;
  }
  messages.push({ role: "system", content: systemText });

  for (const msg of body.messages || []) {
    const content = msg.content;

    if (msg.role === "user") {
      const text = textFromContent(content);
      const toolResults = extractToolResults(content);

      // Tool results must immediately follow assistant tool_calls — put them first
      for (const tr of toolResults) {
        let tc;
        if (typeof tr.content === "string") {
          tc = tr.content;
        } else if (Array.isArray(tr.content)) {
          tc = tr.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else {
          tc = JSON.stringify(tr.content);
        }
        messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tc });
      }
      if (text) messages.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const text = textFromContent(content);
      const toolUses = extractToolUses(content);
      const thinking = extractThinking(content);

      const oai = { role: "assistant" };
      if (text) oai.content = text;
      else if (toolUses.length === 0) oai.content = null;

      if (thinking.length > 0) {
        oai.reasoning_content = thinking
          .map((t) => t.thinking || t.text || t.signature || "")
          .join("\n");
      }

      if (toolUses.length > 0) {
        oai.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: {
            name: tu.name,
            arguments:
              typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input),
          },
        }));
        if (!text) delete oai.content;
      }

      // Merge with previous assistant message if consecutive (prevents DeepSeek error)
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        if (oai.content) last.content = (last.content || "") + "\n" + oai.content;
        if (oai.tool_calls) last.tool_calls = [...(last.tool_calls || []), ...oai.tool_calls];
        if (oai.reasoning_content) last.reasoning_content = (last.reasoning_content || "") + oai.reasoning_content;
      } else {
        messages.push(oai);
      }
    }
  }

  const goModel = mapModel(body.model);
  let maxTokens = body.max_tokens || 4096;
  // Only apply reasoning floor for non-trivial requests (classifier calls are tiny)
  if (REASONING_MODELS.has(goModel) && maxTokens >= 1000) {
    maxTokens = Math.max(maxTokens, REASONING_TOKEN_FLOOR[goModel] || 8000);
  }

  const openai = {
    model: goModel,
    messages,
    max_tokens: maxTokens,
    stream: !!body.stream,
  };

  if (body.temperature != null) openai.temperature = body.temperature;
  if (body.top_p != null) openai.top_p = body.top_p;
  if (body.top_k != null) openai.top_k = body.top_k;

  if (body.tools?.length) {
    openai.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
    openai.tool_choice = "auto";
  }

  if (body.stop_sequences?.length) openai.stop = body.stop_sequences;
  if (body.stream) openai.stream_options = { include_usage: true };

  return openai;
}

/* ── OpenAI → Anthropic response translation (non-streaming) ── */

function openAIToAnthropic(res, originalModel) {
  const choice = res.choices?.[0];
  if (!choice) return { type: "error", error: { message: "No choices" } };

  const msg = choice.message;
  const content = [];

  if (msg.reasoning_content) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
  if (msg.content) content.push({ type: "text", text: msg.content });

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: res.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason:
      choice.finish_reason === "tool_calls"
        ? "tool_use"
        : choice.finish_reason === "stop"
          ? "end_turn"
          : choice.finish_reason === "length"
            ? "max_tokens"
            : "end_turn",
    usage: res.usage
      ? {
          input_tokens: res.usage.prompt_tokens || 0,
          output_tokens: res.usage.completion_tokens || 0,
          cache_read_input_tokens: res.usage.prompt_tokens_details?.cached_tokens || 0,
        }
      : { input_tokens: 0, output_tokens: 0 },
  };
}

/* ── SSE streaming: OpenAI → Anthropic ── */

async function streamOpenAIToAnthropic(fetchRes, res, originalModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });

  const msgId = `msg_${Date.now()}`;
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: originalModel, content: [], usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);

  const reader = fetchRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let blockIdx = 0;
  const toolCalls = {};
  let thinkingBlockIdx = -1;
  let textBlockIdx = -1;
  let finishReason = "end_turn";
  let totalOutput = 0;
  let lastPing = Date.now();
  const PING_INTERVAL = 15000;

  const ping = setInterval(() => {
    if (Date.now() - lastPing >= PING_INTERVAL) {
      res.write(`event: ping\ndata: {}\n\n`);
      lastPing = Date.now();
    }
  }, PING_INTERVAL);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lastPing = Date.now();
      buf += decoder.decode(value, { stream: true });

      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        let d = t.slice(5).trim();
        if (!d || d === "[DONE]" || d.startsWith("[DONE]")) continue;
        if (d.includes('"cost"')) continue;

        try {
          const chunk = JSON.parse(d);
          const delta = chunk.choices?.[0]?.delta;
          const chunkUsage = chunk.usage;
          const fr = chunk.choices?.[0]?.finish_reason;

          if (fr) finishReason = fr;

          if (chunkUsage) {
            totalOutput = chunkUsage.completion_tokens || 0;
            continue;
          }
          if (!delta) continue;

          if (delta.reasoning_content && thinkingBlockIdx === -1) {
            thinkingBlockIdx = blockIdx;
            blockIdx++;
            res.write(
              `event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start",
                index: thinkingBlockIdx,
                content_block: { type: "thinking", thinking: "" },
              })}\n\n`
            );
          }
          if (delta.reasoning_content) {
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: thinkingBlockIdx,
                delta: {
                  type: "thinking_delta",
                  thinking: delta.reasoning_content,
                },
              })}\n\n`
            );
          }

          if (delta.content) {
            if (textBlockIdx === -1) {
              textBlockIdx = blockIdx;
              blockIdx++;
              res.write(
                `event: content_block_start\ndata: ${JSON.stringify({
                  type: "content_block_start",
                  index: textBlockIdx,
                  content_block: { type: "text", text: "" },
                })}\n\n`
              );
            }
            res.write(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: "content_block_delta",
                index: textBlockIdx,
                delta: { type: "text_delta", text: delta.content },
              })}\n\n`
            );
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls[idx]) {
                toolCalls[idx] = {
                  id: tc.id || "",
                  name: tc.function?.name || "",
                  args: "",
                  blockIdx: blockIdx++,
                };
                res.write(
                  `event: content_block_start\ndata: ${JSON.stringify({
                    type: "content_block_start",
                    index: toolCalls[idx].blockIdx,
                    content_block: {
                      type: "tool_use",
                      id: toolCalls[idx].id,
                      name: toolCalls[idx].name,
                    },
                  })}\n\n`
                );
              }
              if (tc.function?.arguments) {
                toolCalls[idx].args += tc.function.arguments;
                res.write(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: "content_block_delta",
                    index: toolCalls[idx].blockIdx,
                    delta: {
                      type: "input_json_delta",
                      partial_json: tc.function.arguments,
                    },
                  })}\n\n`
                );
              }
            }
          }
        } catch {
          /* skip unparseable */
        }
      }
    }
  } finally {
    clearInterval(ping);
    try {
      reader.releaseLock();
    } catch {
      /* ok */
    }
  }

  for (let i = 0; i < blockIdx; i++) {
    res.write(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: i,
      })}\n\n`
    );
  }

  const sr =
    finishReason === "tool_calls" ? "tool_use"
    : finishReason === "length" ? "max_tokens"
    : "end_turn";

  res.write(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: sr, stop_sequence: null },
      usage: { output_tokens: totalOutput },
    })}\n\n`
  );
  res.write(
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
  );
  res.end();
}

/* ── HTTP server ── */

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      d += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  log(`${req.method} ${req.url}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-api-key, anthropic-version, anthropic-beta"
  );

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  const urlPath = req.url.split("?")[0];

  if (req.method === "HEAD" && urlPath === "/") {
    res.writeHead(200);
    return res.end();
  }

  if (req.method === "GET" && urlPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ status: "ok", mappings: MODEL_MAP, target: TARGET })
    );
  }

  if (req.method === "POST" && urlPath === "/v1/messages") {
    try {
      const body = await readBody(req);
      const originalModel = body.model;
      const openai = anthropicToOpenAI(body);
      const goModel = openai.model;

      log(`${originalModel} → ${goModel} stream=${openai.stream}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
      const upstream = await fetch(`${TARGET}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(openai),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!upstream.ok) {
        const errText = await upstream.text();
        log(`UPSTREAM ${upstream.status}: ${errText.slice(0, 200)}`);
        let errType = "api_error";
        if (upstream.status === 429) errType = "rate_limit_error";
        else if (upstream.status === 401 || upstream.status === 403) errType = "authentication_error";
        else if (upstream.status >= 500) errType = "overloaded_error";
        else if (upstream.status === 400) errType = "invalid_request_error";
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ type: "error", error: { type: errType, message: errText } })
        );
      }

      if (openai.stream) {
        return await streamOpenAIToAnthropic(upstream, res, originalModel);
      }

      const data = await upstream.json();
      const transformed = openAIToAnthropic(data, originalModel);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(transformed));
    } catch (err) {
      log(`ERROR: ${err.message}`);
      if (err.name === "AbortError") {
        res.writeHead(504, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Upstream timeout" } })
        );
      }
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } })
      );
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  return res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(
    `\n${"=".repeat(52)}\n  OpenCode Go → Claude Code Proxy\n  http://localhost:${PORT}\n${"=".repeat(52)}`
  );
  console.log("\nModel mappings:");
  for (const [k, v] of Object.entries(MODEL_MAP)) {
    console.log(`  ${k.padEnd(30)} → ${v}`);
  }
  console.log(
    `\n  Set: ANTHROPIC_BASE_URL=http://localhost:${PORT}\n`
  );
});

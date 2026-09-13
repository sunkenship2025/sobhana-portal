#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

const PORT = Number(process.env.PORT || process.env.GLAUDE_PROXY_PORT || 8787);
const UPSTREAM_BASE_URL = (process.env.GO_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = stripProvider(process.env.GLAUDE_MODEL || process.env.GO_MODEL || "kimi-k3");
const MODEL_ALIASES = parseModelAliases();
const API_KEY = process.env.GO_API_KEY || process.env.OPENCODE_GO_API_KEY || "";
const METRICS_FILE = process.env.GLAUDE_METRICS_FILE || "/tmp/glaude-metrics.jsonl";

if (!API_KEY) {
  console.error("Missing GO_API_KEY or OPENCODE_GO_API_KEY");
  process.exit(1);
}

function stripProvider(model) {
  return String(model || "").replace(/^opencode-go\//, "");
}

function parseModelAliases() {
  const aliases = {
    fable: process.env.GLAUDE_MODEL_FABLE || process.env.GLAUDE_MODEL || process.env.GO_MODEL || "kimi-k3",
    opus: process.env.GLAUDE_MODEL_OPUS || "deepseek-v4-pro",
    sonnet: process.env.GLAUDE_MODEL_SONNET || "deepseek-v4-flash",
    haiku: process.env.GLAUDE_MODEL_HAIKU || "deepseek-v4-flash",
  };

  if (process.env.GLAUDE_MODEL_ALIASES) {
    try {
      Object.assign(aliases, JSON.parse(process.env.GLAUDE_MODEL_ALIASES));
    } catch {
      console.error("Ignoring invalid GLAUDE_MODEL_ALIASES JSON");
    }
  }

  return Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, stripProvider(value)]));
}

function resolveModel(model) {
  const value = String(model || "").trim();
  if (!value) return DEFAULT_MODEL;
  const normalized = value.toLowerCase();
  for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
    if (normalized === alias || normalized.includes(alias)) return target;
  }
  if (value.startsWith("opencode-go/")) return stripProvider(value);
  if (/^kimi-k\d/i.test(value)) return value;
  return DEFAULT_MODEL;
}

function providerAdapter(model) {
  const normalized = stripProvider(model).toLowerCase();
  if (normalized.startsWith("deepseek")) {
    return "Glaude adapter: make minimal edits; preserve project style; avoid speculative refactors.";
  }
  if (normalized.startsWith("kimi")) {
    return "Glaude adapter: answer decisively; avoid unnecessary clarification; keep plans brief.";
  }
  if (normalized.startsWith("qwen")) {
    return "Glaude adapter: reduce verbosity; focus on requested work; keep formatting consistent.";
  }
  return "";
}

function estimateTokens(value) {
  if (!value) return 0;
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function isPlainTextContent(content) {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((block) => block?.type === "text");
}

function mergePlainTextContent(left, right) {
  return `${normalizeText(left)}\n\n${normalizeText(right)}`;
}

function stripEmptyTextBlocks(content) {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => block?.type !== "text" || String(block.text || "").trim() !== "");
}

function deduplicateSystemInstructions(system) {
  const text = normalizeText(system);
  if (!text) return system;
  const paragraphs = text.split(/\n\n+/);
  const seen = new Set();
  const unique = [];
  for (const para of paragraphs) {
    const key = para.trim().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(para);
  }
  return unique.join("\n\n");
}

function normalizeWhitespace(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTextContent(content) {
  if (typeof content === "string") return normalizeWhitespace(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: normalizeWhitespace(block.text) };
    }
    return block;
  });
}

function toThinkingParams(body, targetModel) {
  if (!body?.thinking || body.thinking.type !== "enabled") return undefined;
  const budget = typeof body.thinking.budget_tokens === "number" ? body.thinking.budget_tokens : 0;
  const normalized = stripProvider(targetModel).toLowerCase();
  if (normalized.startsWith("deepseek")) {
    const level = budget <= 1024 ? "low" : budget <= 4096 ? "medium" : "high";
    return { reasoning_effort: level };
  }
  if (normalized.startsWith("kimi")) {
    return { enable_thinking: true };
  }
  if (normalized.startsWith("qwen")) {
    return { enable_thinking: true };
  }
  if (budget > 0) {
    const level = budget <= 1024 ? "low" : budget <= 4096 ? "medium" : "high";
    return { reasoning_effort: level };
  }
  return undefined;
}

function compressRepeatedContent(messages) {
  const contentCache = new Map();
  let compressedBlocks = 0;
  let bytesSaved = 0;

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type !== "tool_result") continue;
      const raw = normalizeText(block.content);
      if (!raw || raw.length < 200) continue;
      const hash = raw.length + ":" + raw.slice(0, 120) + raw.slice(-80);
      const firstSeen = contentCache.get(hash);
      if (firstSeen !== undefined) {
        const before = JSON.stringify(block.content).length;
        block.content = `[CACHED — same output as earlier result for tool call "${firstSeen}"]`;
        block.is_compressed = true;
        bytesSaved += before - JSON.stringify(block.content).length;
        compressedBlocks++;
      } else {
        contentCache.set(hash, block.tool_use_id || "unknown");
      }
    }
  }
  return { compressedBlocks, bytesSaved };
}

function optimizeAnthropicBody(body, targetModel) {
  const optimized = { ...body };

  let systemText = optimized.system ? normalizeText(optimized.system).trim() : "";
  const adapter = providerAdapter(targetModel);
  if (adapter) {
    systemText = systemText ? `${systemText}\n\n${adapter}` : adapter;
  }
  if (systemText) {
    optimized.system = deduplicateSystemInstructions(systemText);
  }

  const messages = [];
  const toolResultCache = new Set();
  for (const rawMessage of body.messages || []) {
    const message = {
      ...rawMessage,
      content: normalizeTextContent(stripEmptyTextBlocks(rawMessage.content)),
    };
    const previous = messages[messages.length - 1];
    if (previous && JSON.stringify(previous) === JSON.stringify(message)) continue;
    if (
      previous &&
      previous.role === message.role &&
      isPlainTextContent(previous.content) &&
      isPlainTextContent(message.content)
    ) {
      previous.content = mergePlainTextContent(previous.content, message.content);
      continue;
    }
    if (message.role === "user" && Array.isArray(message.content)) {
      const toolResults = message.content.filter((block) => block?.type === "tool_result");
      if (toolResults.length && toolResults.every((block) => {
        const fingerprint = JSON.stringify({ id: block.tool_use_id, content: block.content });
        if (toolResultCache.has(fingerprint)) return true;
        toolResultCache.add(fingerprint);
        return false;
      })) {
        continue;
      }
    }
    messages.push(message);
  }

  const compression = compressRepeatedContent(messages);
  optimized.messages = messages;
  optimized._compression = compression;
  return optimized;
}

function logMetric(metric) {
  try {
    fs.appendFileSync(METRICS_FILE, `${JSON.stringify({ timestamp: new Date().toISOString(), ...metric })}\n`);
  } catch {
    // Metrics must never break model calls.
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400, cause: error }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function normalizeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      if (block.type === "text") return block.text || "";
      if (block.type === "thinking") return block.thinking || "";
      if (block.type === "tool_result") {
        const body = normalizeText(block.content);
        return body ? `Tool result (${block.tool_use_id || "unknown"}):\n${body}` : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeOpenAiContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeText(content);

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text || "" });
      continue;
    }
    if (block.type === "image" && block.source?.type === "base64") {
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${block.source.media_type || "image/png"};base64,${block.source.data || ""}`,
        },
      });
      continue;
    }
    if (block.type === "tool_result") {
      const text = normalizeText(block.content);
      if (text) parts.push({ type: "text", text: `Tool result (${block.tool_use_id || "unknown"}):\n${text}` });
    }
  }

  if (!parts.length) return "";
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function anthropicMessagesToOpenAi(body) {
  const messages = [];

  if (body.system) {
    messages.push({
      role: "system",
      content: normalizeText(body.system),
    });
  }

  for (const message of body.messages || []) {
    const content = message.content;
    if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) {
      const textBlocks = content.filter((block) => block?.type !== "tool_result");
      if (textBlocks.length) {
        messages.push({
          role: "user",
          content: normalizeOpenAiContent(textBlocks),
        });
      }
      for (const block of content.filter((item) => item?.type === "tool_result")) {
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id || "tool_call",
          content: normalizeText(block.content),
        });
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(content)) {
      const text = content.filter((block) => block?.type === "text").map((block) => block.text || "").join("\n");
      const toolCalls = content
        .filter((block) => block?.type === "tool_use")
        .map((block) => ({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        }));

      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    messages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: normalizeOpenAiContent(content),
    });
  }

  return messages;
}

function anthropicToolsToOpenAi(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
    },
  }));
}

function anthropicToolChoiceToOpenAi(choice) {
  if (!choice) return undefined;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "tool") {
    return {
      type: "function",
      function: { name: choice.name },
    };
  }
  return undefined;
}

function toOpenAiRequest(body) {
  const targetModel = resolveModel(body.model);
  const optimizedBody = optimizeAnthropicBody(body, targetModel);
  const thinking = toThinkingParams(body, targetModel);
  const request = {
    model: targetModel,
    messages: anthropicMessagesToOpenAi(optimizedBody),
    stream: Boolean(optimizedBody.stream),
    max_tokens: optimizedBody.max_tokens || 4096,
    _glaude: {
      requestedModel: body.model || "",
      inputTokensEstimated: estimateTokens(body),
      optimizedInputTokensEstimated: estimateTokens(optimizedBody),
      systemTokensEstimated: estimateTokens(optimizedBody.system),
      conversationTokensEstimated: estimateTokens(optimizedBody.messages),
      toolTokensEstimated: estimateTokens(optimizedBody.tools),
      toolCount: Array.isArray(optimizedBody.tools) ? optimizedBody.tools.length : 0,
      thinkingBudget: body?.thinking?.budget_tokens ?? null,
      thinkingEnabled: body?.thinking?.type === "enabled",
      optimization: {
        messagesBefore: Array.isArray(body.messages) ? body.messages.length : 0,
        messagesAfter: optimizedBody.messages.length,
      },
    },
  };
  if (thinking) Object.assign(request, thinking);

  const tools = anthropicToolsToOpenAi(optimizedBody.tools);
  if (tools?.length) request.tools = tools;

  const toolChoice = anthropicToolChoiceToOpenAi(optimizedBody.tool_choice);
  if (toolChoice) request.tool_choice = toolChoice;

  if (typeof optimizedBody.top_p === "number") request.top_p = optimizedBody.top_p;
  if (typeof optimizedBody.stop_sequences !== "undefined") request.stop = optimizedBody.stop_sequences;
  if (typeof optimizedBody.temperature === "number" && process.env.GLAUDE_FORWARD_TEMPERATURE === "1") {
    request.temperature = optimizedBody.temperature;
  }

  return request;
}

async function callOpenAi(request) {
  const { _glaude, ...upstreamRequest } = request;
  const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(upstreamRequest),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`GO API request failed: ${response.status} ${response.statusText}`);
    error.statusCode = response.status;
    error.upstreamBody = text;
    throw error;
  }

  return response;
}

function convertStopReason(reason) {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return "end_turn";
}

function convertNonStreamingResponse(openAi, model) {
  const choice = openAi.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (message.content) {
    content.push({
      type: "text",
      text: Array.isArray(message.content) ? normalizeText(message.content) : String(message.content),
    });
  }

  for (const call of message.tool_calls || []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function?.name || "tool",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  return {
    id: openAi.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: convertStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openAi.usage?.prompt_tokens || 0,
      output_tokens: openAi.usage?.completion_tokens || 0,
    },
  };
}

function parseToolArguments(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function proxyStream(upstream, res, model) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let textBlockStarted = false;
  let nextBlockIndex = 0;
  let outputTokens = 0;
  const toolBlocks = new Map();
  let finalStopReason = "end_turn";

  sendSse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = frame
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith("data:"));

      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0] || {};
      const delta = choice.delta || {};
      if (parsed.usage?.completion_tokens) outputTokens = parsed.usage.completion_tokens;
      if (choice.finish_reason) finalStopReason = convertStopReason(choice.finish_reason);

      if (delta.content) {
        if (!textBlockStarted) {
          textBlockStarted = true;
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: nextBlockIndex,
            content_block: { type: "text", text: "" },
          });
          nextBlockIndex += 1;
        }
        sendSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const call of delta.tool_calls || []) {
        const key = call.index ?? toolBlocks.size;
        let block = toolBlocks.get(key);
        if (!block) {
          block = {
            index: nextBlockIndex,
            id: call.id || `toolu_${Date.now()}_${key}`,
            name: call.function?.name || "",
          };
          toolBlocks.set(key, block);
          sendSse(res, "content_block_start", {
            type: "content_block_start",
            index: block.index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name || "tool",
              input: {},
            },
          });
          nextBlockIndex += 1;
        }

        if (call.function?.name && !block.name) block.name = call.function.name;
        if (call.function?.arguments) {
          sendSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: {
              type: "input_json_delta",
              partial_json: call.function.arguments,
            },
          });
        }
      }
    }
  }

  if (textBlockStarted) {
    sendSse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  }
  for (const block of toolBlocks.values()) {
    sendSse(res, "content_block_stop", { type: "content_block_stop", index: block.index });
  }
  sendSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: finalStopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  sendSse(res, "message_stop", { type: "message_stop" });
  res.end();
  return { outputTokens, stopReason: finalStopReason };
}

async function handleMessages(req, res) {
  const body = await readBody(req);
  const startedAt = performance.now();
  const openAiRequest = toOpenAiRequest(body);
  const upstream = await callOpenAi(openAiRequest);
  const baseMetric = {
    provider: "opencode-go",
    model: openAiRequest.model,
    requestedModel: openAiRequest._glaude.requestedModel,
    inputTokensEstimated: openAiRequest._glaude.inputTokensEstimated,
    optimizedInputTokensEstimated: openAiRequest._glaude.optimizedInputTokensEstimated,
    systemTokensEstimated: openAiRequest._glaude.systemTokensEstimated,
    conversationTokensEstimated: openAiRequest._glaude.conversationTokensEstimated,
    toolTokensEstimated: openAiRequest._glaude.toolTokensEstimated,
    toolCount: openAiRequest._glaude.toolCount,
    thinkingBudget: openAiRequest._glaude.thinkingBudget,
    thinkingEnabled: openAiRequest._glaude.thinkingEnabled,
    optimization: openAiRequest._glaude.optimization,
    stream: openAiRequest.stream,
    cacheHit: false,
  };

  if (openAiRequest.stream) {
    const result = await proxyStream(upstream, res, openAiRequest.model);
    logMetric({
      ...baseMetric,
      outputTokens: result.outputTokens,
      stopReason: result.stopReason,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    return;
  }

  const openAi = await upstream.json();
  logMetric({
    ...baseMetric,
    inputTokens: openAi.usage?.prompt_tokens || null,
    outputTokens: openAi.usage?.completion_tokens || null,
    reasoningTokens: openAi.usage?.completion_tokens_details?.reasoning_tokens || null,
    cacheReadTokens: openAi.usage?.prompt_tokens_details?.cached_tokens || null,
    cacheWriteTokens: openAi.usage?.prompt_cache_write_tokens || null,
    cacheHit: !!(openAi.usage?.prompt_tokens_details?.cached_tokens),
    stopReason: convertStopReason(openAi.choices?.[0]?.finish_reason),
    latencyMs: Math.round(performance.now() - startedAt),
  });
  sendJson(res, 200, convertNonStreamingResponse(openAi, openAiRequest.model));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        proxy: "glaude-go-proxy",
        proxyVersion: 2,
        upstream: UPSTREAM_BASE_URL,
        model: DEFAULT_MODEL,
        aliases: MODEL_ALIASES,
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      sendJson(res, 200, {
        data: [
          { id: "claude-sonnet-4-20250514", type: "model", display_name: "Claude Sonnet 4", created_at: "2025-05-14T00:00:00Z" },
          { id: "claude-opus-4-20250514", type: "model", display_name: "Claude Opus 4", created_at: "2025-05-14T00:00:00Z" },
          { id: "claude-3-5-haiku-20241022", type: "model", display_name: "Claude 3.5 Haiku", created_at: "2024-10-22T00:00:00Z" },
        ],
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/messages/count_tokens" || url.pathname === "/messages/count_tokens")) {
      const body = await readBody(req);
      const chars = JSON.stringify(body.messages || []).length + normalizeText(body.system).length;
      sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/messages" || url.pathname === "/messages")) {
      await handleMessages(req, res);
      return;
    }

    sendJson(res, 404, {
      type: "error",
      error: { type: "not_found_error", message: `No route for ${req.method} ${url.pathname}` },
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = error.upstreamBody || error.message || "Unexpected proxy error";
    sendJson(res, statusCode, {
      type: "error",
      error: {
        type: statusCode >= 500 ? "api_error" : "invalid_request_error",
        message,
      },
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`glaude GO proxy listening on http://127.0.0.1:${PORT} -> ${UPSTREAM_BASE_URL} (${DEFAULT_MODEL})`);
});

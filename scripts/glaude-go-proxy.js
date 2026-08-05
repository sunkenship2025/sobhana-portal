#!/usr/bin/env node

const http = require("node:http");

const PORT = Number(process.env.PORT || process.env.GLAUDE_PROXY_PORT || 8787);
const UPSTREAM_BASE_URL = (process.env.GO_BASE_URL || "https://opencode.ai/zen/go/v1").replace(/\/+$/, "");
const DEFAULT_MODEL = stripProvider(process.env.GLAUDE_MODEL || process.env.GO_MODEL || "kimi-k3");
const API_KEY = process.env.GO_API_KEY || process.env.OPENCODE_GO_API_KEY || "";

if (!API_KEY) {
  console.error("Missing GO_API_KEY or OPENCODE_GO_API_KEY");
  process.exit(1);
}

function stripProvider(model) {
  return String(model || "").replace(/^opencode-go\//, "");
}

function resolveModel(model) {
  const value = String(model || "").trim();
  if (!value) return DEFAULT_MODEL;
  if (value === "fable") return DEFAULT_MODEL;
  if (value.startsWith("opencode-go/")) return stripProvider(value);
  if (/^kimi-k\d/i.test(value)) return value;
  return DEFAULT_MODEL;
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
  const request = {
    model: resolveModel(body.model),
    messages: anthropicMessagesToOpenAi(body),
    stream: Boolean(body.stream),
    max_tokens: body.max_tokens || 4096,
  };

  const tools = anthropicToolsToOpenAi(body.tools);
  if (tools?.length) request.tools = tools;

  const toolChoice = anthropicToolChoiceToOpenAi(body.tool_choice);
  if (toolChoice) request.tool_choice = toolChoice;

  if (typeof body.top_p === "number") request.top_p = body.top_p;
  if (typeof body.stop_sequences !== "undefined") request.stop = body.stop_sequences;
  if (typeof body.temperature === "number" && process.env.GLAUDE_FORWARD_TEMPERATURE === "1") {
    request.temperature = body.temperature;
  }

  return request;
}

async function callOpenAi(request) {
  const response = await fetch(`${UPSTREAM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
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
}

async function handleMessages(req, res) {
  const body = await readBody(req);
  const openAiRequest = toOpenAiRequest(body);
  const upstream = await callOpenAi(openAiRequest);

  if (openAiRequest.stream) {
    await proxyStream(upstream, res, openAiRequest.model);
    return;
  }

  const openAi = await upstream.json();
  sendJson(res, 200, convertNonStreamingResponse(openAi, openAiRequest.model));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, upstream: UPSTREAM_BASE_URL, model: DEFAULT_MODEL });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      sendJson(res, 200, {
        data: [
          {
            id: "fable",
            type: "model",
            display_name: "Fable via GO Kimi K3",
            created_at: "2026-08-05T00:00:00Z",
          },
          {
            id: DEFAULT_MODEL,
            type: "model",
            display_name: DEFAULT_MODEL,
            created_at: "2026-08-05T00:00:00Z",
          },
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

import { ensureCopilotToken, state } from "./token-manager.js";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  estimateTokens,
  anthropicError,
} from "./anthropic-adapter.js";
import { AnthropicStreamTranslator } from "./anthropic-stream.js";

function buildHeaders(copilotToken, { vision = false, agent = false } = {}) {
  const headers = {
    Authorization: `Bearer ${copilotToken}`,
    "Content-Type": "application/json",
    "Editor-Version": "vscode/1.96.2",
    "User-Agent": "GitHubCopilotChat/0.26.7",
  };
  // 沒帶這個 header 的話，含圖片的請求會被上游擋掉
  if (vision) headers["Copilot-Vision-Request"] = "true";
  // agent = 工具呼叫流程，上游用這個欄位分流配額
  headers["X-Initiator"] = agent ? "agent" : "user";
  return headers;
}

// 請求 body 裡有沒有圖片
function hasImageContent(body) {
  for (const msg of body?.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type === "image_url" || part?.type === "image") return true;
    }
  }
  return false;
}

// ── 上游模型清單 ────────────────────────────────────────────
// 硬寫清單會過期（實際踩過：Copilot 下架了 claude-sonnet-4，但我們還在送，
// 每次都拿 400 model_not_supported）。改成問上游，快取 10 分鐘。

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache = { ids: null, data: null, fetchedAt: 0, inFlight: null };

async function fetchUpstreamModels() {
  const copilotToken = await ensureCopilotToken();
  const res = await fetch(`${state.apiBaseUrl}/models`, {
    headers: buildHeaders(copilotToken),
  });
  if (!res.ok) throw new Error(`Upstream /models failed: HTTP ${res.status}`);
  const json = await res.json();
  const all = Array.isArray(json.data) ? json.data : [];

  // 只留能對話的：embedding 之類的沒有 max_context_window_tokens
  const chat = all.filter((m) => m?.id && m?.capabilities?.limits?.max_context_window_tokens);
  return { ids: chat.map((m) => m.id), data: chat };
}

// 拿不到就回 null，呼叫端各自退回靜態行為
async function getUpstreamModels() {
  const fresh = Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS;
  if (modelsCache.ids && fresh) return modelsCache;
  if (modelsCache.inFlight) return modelsCache.inFlight;

  modelsCache.inFlight = (async () => {
    try {
      const { ids, data } = await fetchUpstreamModels();
      modelsCache = { ids, data, fetchedAt: Date.now(), inFlight: null };
      return modelsCache;
    } catch (err) {
      console.error(`⚠️  取不到上游模型清單，改用靜態對照：${err.message}`);
      modelsCache.inFlight = null;
      // 有舊資料就繼續用舊的，別因為一次失敗就退化
      return modelsCache.ids ? modelsCache : null;
    }
  })();

  return modelsCache.inFlight;
}

// OpenAI 與 Anthropic 兩條路徑共用的上游呼叫
async function callCopilot(openaiBody) {
  const copilotToken = await ensureCopilotToken();
  const targetUrl = `${state.apiBaseUrl}/chat/completions`;

  const agent =
    Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0;

  return fetch(targetUrl, {
    method: "POST",
    headers: buildHeaders(copilotToken, {
      vision: hasImageContent(openaiBody),
      agent,
    }),
    body: JSON.stringify(openaiBody),
  });
}

// ── OpenAI 相容端點（原本的行為，未改動語意）────────────────

// Returns { success: boolean } so caller can track stats accurately
async function proxyRequest(req, res) {
  const start = Date.now();
  const model = req.body?.model || "unknown";
  const isStream = req.body?.stream === true;

  try {
    const upstream = await callCopilot(req.body);

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`❌ ${model} ${upstream.status} (${Date.now() - start}ms)${isStream ? " [stream]" : ""}`);
      res.status(upstream.status).json({
        error: {
          message: `Copilot API error: ${upstream.status}`,
          detail: errText,
        },
      });
      return { success: false };
    }

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);
        }
      } catch (e) {
        // client disconnected or upstream error
        return { success: false };
      } finally {
        res.end();
      }
    } else {
      const json = await upstream.json();
      res.json(json);
    }
    console.log(`✅ ${model} 200 (${Date.now() - start}ms)${isStream ? " [stream]" : ""}`);
    return { success: true };
  } catch (err) {
    console.error(`❌ ${model} 502 (${Date.now() - start}ms): ${err.message}`);
    res.status(502).json({
      error: {
        message: err.message || "Proxy error",
      },
    });
    return { success: false };
  }
}

// ── Anthropic Messages 端點（Claude Code 用這條）─────────────

async function anthropicRequest(req, res) {
  const start = Date.now();
  const body = req.body || {};
  const requestedModel = body.model || "unknown";
  const isStream = body.stream === true;

  // Anthropic 規定 max_tokens 必填
  if (typeof body.max_tokens !== "number") {
    res.status(400).json(anthropicError(400, "max_tokens is required"));
    return { success: false };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json(anthropicError(400, "messages must be a non-empty array"));
    return { success: false };
  }

  // 依上游即時清單挑模型，取不到清單就退回靜態對照
  const upstreamModels = await getUpstreamModels().catch(() => null);

  let openaiBody;
  try {
    openaiBody = anthropicToOpenAI(body, upstreamModels?.ids ?? null);
  } catch (err) {
    res.status(400).json(anthropicError(400, `Request translation failed: ${err.message}`));
    return { success: false };
  }

  const label = `${requestedModel}→${openaiBody.model}`;

  try {
    const upstream = await callCopilot(openaiBody);

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`❌ [anthropic] ${label} ${upstream.status} (${Date.now() - start}ms)`);
      res
        .status(upstream.status)
        .json(anthropicError(upstream.status, `Copilot API error ${upstream.status}: ${errText}`));
      return { success: false };
    }

    if (isStream) {
      return await streamAnthropic(upstream, res, {
        model: requestedModel,
        inputTokens: estimateTokens(body),
        label,
        start,
      });
    }

    const json = await upstream.json();
    res.json(openAIToAnthropic(json, requestedModel));
    console.log(`✅ [anthropic] ${label} 200 (${Date.now() - start}ms)`);
    return { success: true };
  } catch (err) {
    console.error(`❌ [anthropic] ${label} 502 (${Date.now() - start}ms): ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json(anthropicError(502, err.message || "Proxy error"));
    } else {
      res.end();
    }
    return { success: false };
  }
}

async function streamAnthropic(upstream, res, { model, inputTokens, label, start }) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // 別讓反向代理把 SSE 緩衝住
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const translator = new AnthropicStreamTranslator({ model, inputTokens });
  res.write(translator.start());

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const events = translator.feed(decoder.decode(value, { stream: true }));
      if (events) res.write(events);
    }
    res.write(translator.end());
    res.end();
    console.log(`✅ [anthropic] ${label} 200 (${Date.now() - start}ms) [stream]`);
    return { success: true };
  } catch (err) {
    // 一定要把開著的 content block 關掉，否則 Claude Code 會一直等
    console.error(`❌ [anthropic] ${label} stream aborted (${Date.now() - start}ms): ${err.message}`);
    try {
      res.write(translator.abort(err.message));
      res.end();
    } catch {
      // client 已經斷線
    }
    return { success: false };
  }
}

export {
  proxyRequest,
  anthropicRequest,
  callCopilot,
  buildHeaders,
  hasImageContent,
  getUpstreamModels,
};

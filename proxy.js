import { ensureCopilotToken, state } from "./token-manager.js";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  estimateTokens,
  anthropicError,
  mapModel,
  classifyTier,
  stripDateSuffix,
} from "./anthropic-adapter.js";
import { AnthropicStreamTranslator } from "./anthropic-stream.js";
import {
  supportsNativeMessages,
  prepareNativeBody,
  stripCopilotFields,
} from "./anthropic-native.js";

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

// 伺服器端強制指定的模型。Claude Code 用 /model 存過的預設會蓋掉
// ANTHROPIC_MODEL 環境變數，所以要在 proxy 這邊才壓得住。
const DEFAULT_MODEL_OVERRIDE = (process.env.COPILOT_DEFAULT_MODEL || "").trim() || null;

// 伺服器端預設思考檔位。Claude Code 不一定會把它自己的 effort 設定透過
// Anthropic 協議送出來，所以留一個不依賴 client 的開關。
const DEFAULT_THINKING_EFFORT = (process.env.COPILOT_THINKING_EFFORT || "").trim() || null;

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
let modelsCache = { ids: null, data: null, byId: null, fetchedAt: 0, inFlight: null };

async function fetchUpstreamModels() {
  const copilotToken = await ensureCopilotToken();
  const headers = buildHeaders(copilotToken);
  // GET 是 idempotent，重試沒有重複計費的顧慮，可以放寬到連線建立後才斷的錯誤
  const res = await fetchWithRetry(
    () => fetch(`${state.apiBaseUrl}/models`, { headers }),
    { label: "GET /models", attempts: 3, idempotent: true }
  );
  if (!res.ok) throw new Error(`Upstream /models failed: HTTP ${res.status}`);
  const json = await res.json();
  const all = Array.isArray(json.data) ? json.data : [];

  // 只留能對話的：embedding 之類的沒有 max_context_window_tokens
  const chat = all.filter((m) => m?.id && m?.capabilities?.limits?.max_context_window_tokens);
  return {
    ids: chat.map((m) => m.id),
    data: chat,
    byId: new Map(chat.map((m) => [m.id, m])),
  };
}

// 拿不到就回 null，呼叫端各自退回靜態行為
async function getUpstreamModels() {
  const fresh = Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS;
  if (modelsCache.ids && fresh) return modelsCache;
  if (modelsCache.inFlight) return modelsCache.inFlight;

  modelsCache.inFlight = (async () => {
    try {
      const fetched = await fetchUpstreamModels();
      modelsCache = { ...fetched, fetchedAt: Date.now(), inFlight: null };
      return modelsCache;
    } catch (err) {
      console.error(`⚠️  取不到上游模型清單，改用靜態對照：${describeError(err)}`);
      modelsCache.inFlight = null;
      // 有舊資料就繼續用舊的，別因為一次失敗就退化
      return modelsCache.ids ? modelsCache : null;
    }
  })();

  return modelsCache.inFlight;
}

// Node 的 fetch 把真正的原因藏在 err.cause 裡，只印 message 會得到一句
// 毫無資訊的 "fetch failed"。實際遇過，所以一定要展開。
function describeError(err) {
  const parts = [err?.message || String(err)];
  const cause = err?.cause;
  if (cause) {
    const bits = [cause.code, cause.errno, cause.syscall, cause.message].filter(Boolean);
    if (bits.length > 0) parts.push(`cause=${bits.join(" ")}`);
  }
  return parts.join(" | ");
}

// 我們重試的是 POST，而 Copilot 是按請求計費的。所以只有在「請求確定沒送達
// 上游」時才能重試 —— 否則上游可能已經處理完、只是回應在路上掉了，重試就是
// 付兩次錢。
//
// 連線根本沒建立起來，請求不可能送出去：重試安全。
const RETRY_SAFE_CODES = new Set([
  "ECONNREFUSED", // 對方沒在聽
  "EAI_AGAIN", // DNS 暫時查不到
  "UND_ERR_CONNECT_TIMEOUT", // 連線階段就逾時
]);

// 連線建立之後才斷的：請求可能已經送達並被處理。不重試，讓 client 自己決定
// （Claude Code 本來就會重試，而且它知道自己的上下文）。
const RETRY_UNSAFE_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
]);

// GET 專用：重送沒有副作用，所以連線建立後才斷的也值得重試
function isRetryableForIdempotent(err) {
  const code = err?.cause?.code || err?.code;
  if (code) return RETRY_SAFE_CODES.has(code) || RETRY_UNSAFE_CODES.has(code);
  return err?.name === "TypeError" && /fetch failed/i.test(err?.message || "");
}

function isTransientNetworkError(err) {
  const code = err?.cause?.code || err?.code;
  // 有明確的 code 就以它為準
  if (code) return RETRY_SAFE_CODES.has(code);
  // 沒有 code 的 undici "fetch failed" 情況不明 —— 可能已送達，所以不重試。
  // 寧可讓 client 看到 502 自己重試，也不要偷偷付兩次錢。
  return false;
}

// 只在還沒開始寫回應之前重試 —— 串流一旦吐出位元組就不能重來
// idempotent: true 代表這個請求重送不會有副作用（GET），可以連「送達後才斷」
// 的錯誤也一起重試。POST 一律用嚴格判斷，見 isTransientNetworkError。
async function fetchWithRetry(doFetch, { label, attempts = 2, idempotent = false } = {}) {
  const retryable = idempotent ? isRetryableForIdempotent : isTransientNetworkError;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await doFetch();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !retryable(err)) throw err;
      const wait = 300 * (i + 1);
      console.warn(`⚠️  ${label} 連線失敗，${wait}ms 後重試：${describeError(err)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// COPILOT_DEFAULT_MODEL 的套用規則。
// 刻意跳過 haiku 階：那是 Claude Code 跑背景小任務用的，把它抬成 opus
// 只會白花錢，而且那些任務不需要好模型。
function applyModelOverride(requested) {
  if (!DEFAULT_MODEL_OVERRIDE) return requested;
  if (classifyTier(stripDateSuffix(requested || "")) === "haiku") return requested;
  return DEFAULT_MODEL_OVERRIDE;
}

// 原生 /v1/messages 用的 header。Anthropic 協議自己的 header 要帶過去。
function buildNativeHeaders(copilotToken, req, { vision, agent }) {
  const headers = buildHeaders(copilotToken, { vision, agent });
  headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
  const beta = req.headers["anthropic-beta"];
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

// Anthropic 原生 body 裡有沒有圖片（跟 OpenAI 那版的欄位不同）
function hasNativeImage(body) {
  for (const msg of body?.messages || []) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "image") return true;
    }
  }
  return false;
}

// OpenAI 與 Anthropic 兩條路徑共用的上游呼叫
async function callCopilot(openaiBody) {
  const copilotToken = await ensureCopilotToken();
  const targetUrl = `${state.apiBaseUrl}/chat/completions`;

  const agent =
    Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0;

  const headers = buildHeaders(copilotToken, {
    vision: hasImageContent(openaiBody),
    agent,
  });
  const payload = JSON.stringify(openaiBody);

  return fetchWithRetry(
    () => fetch(targetUrl, { method: "POST", headers, body: payload }),
    { label: openaiBody.model || "chat/completions" }
  );
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
    console.error(`❌ ${model} 502 (${Date.now() - start}ms): ${describeError(err)}`);
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
  const resolvedId = mapModel(applyModelOverride(requestedModel), upstreamModels?.ids ?? null);
  const modelInfo = upstreamModels?.byId?.get(resolvedId) ?? null;

  // Copilot 對 Claude 模型有原生 /v1/messages —— 直接轉發，不經 OpenAI 轉譯。
  // 這條路才拿得到 extended thinking、prompt caching 和精確 token 計數。
  if (supportsNativeMessages(modelInfo)) {
    return await nativeAnthropicRequest(req, res, {
      requestedModel,
      resolvedId,
      modelInfo,
      isStream,
      start,
    });
  }

  // 非 Claude 模型（gpt-*/gemini-*）只有 /chat/completions，走轉譯層
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
    console.error(`❌ [anthropic] ${label} 502 (${Date.now() - start}ms): ${describeError(err)}`);
    if (!res.headersSent) {
      res.status(502).json(anthropicError(502, err.message || "Proxy error"));
    } else {
      res.end();
    }
    return { success: false };
  }
}

// ── 原生 passthrough ────────────────────────────────────────

async function nativeAnthropicRequest(req, res, { requestedModel, resolvedId, modelInfo, isStream, start }) {
  const label = `${requestedModel}→${resolvedId}`;
  const { body, notes } = prepareNativeBody(req.body, resolvedId, modelInfo, {
    defaultEffort: DEFAULT_THINKING_EFFORT,
  });

  // 記錄 client 到底送了什麼思考參數 —— 用來判斷 Claude Code 有沒有送
  const asked = req.body?.thinking || req.body?.output_config?.effort;
  if (asked) {
    console.log(
      `   ↳ [native] client 要求 thinking=${JSON.stringify(req.body.thinking)}` +
        ` output_config=${JSON.stringify(req.body.output_config)}`
    );
  }
  for (const note of notes) {
    console.log(`   ↳ [native] ${note}`);
  }

  try {
    const copilotToken = await ensureCopilotToken();
    const payload = JSON.stringify(body);
    const headers = buildNativeHeaders(copilotToken, req, {
      vision: hasNativeImage(body),
      agent: Array.isArray(body.tools) && body.tools.length > 0,
    });
    const upstream = await fetchWithRetry(
      () => fetch(`${state.apiBaseUrl}/v1/messages`, { method: "POST", headers, body: payload }),
      { label: `[native] ${label}` }
    );

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`❌ [native] ${label} ${upstream.status} (${Date.now() - start}ms): ${errText.slice(0, 300)}`);
      // 上游已經是 Anthropic 錯誤格式，能原樣轉就原樣轉
      let payload;
      try {
        const parsed = JSON.parse(errText);
        payload = parsed?.type === "error" ? parsed : anthropicError(upstream.status, errText);
      } catch {
        payload = anthropicError(upstream.status, errText);
      }
      res.status(upstream.status).json(payload);
      return { success: false };
    }

    if (isStream) {
      return await pipeNativeStream(upstream, res, { label, start });
    }

    const raw = await upstream.json();
    const { json, costNanoAiu } = stripCopilotFields(raw);
    res.json(json);

    const think = json.usage?.output_tokens_details?.thinking_tokens;
    console.log(
      `✅ [native] ${label} 200 (${Date.now() - start}ms)` +
        ` in=${json.usage?.input_tokens ?? "?"} out=${json.usage?.output_tokens ?? "?"}` +
        (think ? ` think=${think}` : "") +
        (json.usage?.cache_read_input_tokens ? ` cache_read=${json.usage.cache_read_input_tokens}` : "") +
        (costNanoAiu ? ` cost=${costNanoAiu}nAIU` : "")
    );
    return { success: true };
  } catch (err) {
    console.error(`❌ [native] ${label} 502 (${Date.now() - start}ms): ${describeError(err)}`);
    if (!res.headersSent) {
      res.status(502).json(anthropicError(502, err.message || "Proxy error"));
    } else {
      res.end();
    }
    return { success: false };
  }
}

// 原生串流直接轉發位元組，不解析、不重組 —— 這是 passthrough 的重點。
// 只在上游中途爆掉時補一個 error 事件，讓 client 不會無限等待。
async function pipeNativeStream(upstream, res, { label, start }) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let sawMessageStop = false;

  // "message_stop" 可能剛好被 TCP 分片切成兩半（例如 "...messa" + "ge_stop..."）。
  // 逐 chunk 用 includes() 檢查會漏掉，然後在結尾補上第二個 message_stop ——
  // 重複的終止事件會讓 client 困惑。所以留一段跨 chunk 的尾巴一起比對。
  const NEEDLE = "message_stop";
  let tail = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      bytes += chunk.length;
      if (!sawMessageStop && (tail + chunk).includes(NEEDLE)) sawMessageStop = true;
      // 只需要留 needle 長度 - 1 個字元就足以接上被切斷的部分
      tail = (tail + chunk).slice(-(NEEDLE.length - 1));
      res.write(chunk);
    }

    // 上游正常結束但沒送 message_stop，client 會一直等
    if (!sawMessageStop) {
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      console.warn(`⚠️  [native] ${label} 串流結束但沒有 message_stop，已補上`);
    }
    res.end();
    console.log(`✅ [native] ${label} 200 (${Date.now() - start}ms) [stream] ${bytes}B`);
    return { success: true };
  } catch (err) {
    console.error(`❌ [native] ${label} stream aborted (${Date.now() - start}ms): ${describeError(err)}`);
    try {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: "error",
          error: { type: "api_error", message: err.message || "Upstream stream failed" },
        })}\n\n`
      );
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    } catch {
      // client 已經斷線
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
    console.error(`❌ [anthropic] ${label} stream aborted (${Date.now() - start}ms): ${describeError(err)}`);
    try {
      res.write(translator.abort(err.message));
      res.end();
    } catch {
      // client 已經斷線
    }
    return { success: false };
  }
}

// 上游有原生 count_tokens，回的是真值而不是估算
async function nativeCountTokens(req, resolvedId) {
  const copilotToken = await ensureCopilotToken();
  const res = await fetch(`${state.apiBaseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: buildNativeHeaders(copilotToken, req, { vision: false, agent: false }),
    body: JSON.stringify({ ...req.body, model: resolvedId }),
  });
  if (!res.ok) throw new Error(`Upstream count_tokens failed: HTTP ${res.status}`);
  return res.json();
}

export {
  describeError,
  isTransientNetworkError,
  isRetryableForIdempotent,
  fetchWithRetry,
  DEFAULT_THINKING_EFFORT,
  DEFAULT_MODEL_OVERRIDE,
  applyModelOverride,
  proxyRequest,
  anthropicRequest,
  callCopilot,
  buildHeaders,
  hasImageContent,
  getUpstreamModels,
  nativeCountTokens,
};

// Anthropic Messages API ⇄ OpenAI Chat Completions 轉譯層
//
// Claude Code 說的是 Anthropic Messages 協議，GitHub Copilot 只吃 OpenAI
// Chat Completions。這個模組負責兩邊的請求／回應互轉，不碰任何網路 I/O。

// ── Model 對照 ───────────────────────────────────────────────
// Claude Code 會送出帶日期的完整 model id（claude-sonnet-4-5-20250929），
// Copilot 只認短名（claude-sonnet-4.5）。這裡把常見的都對過去。

// 上游拿不到清單時的靜態退路。這張表會過期 —— 正常路徑是
// resolveModel() 依上游 GET /models 的即時清單挑，見下方。
const FALLBACK_MODEL_MAP = {
  "claude-opus-5": "claude-opus-4.8",
  "claude-sonnet-5": "claude-sonnet-5",
  "claude-fable-5": "claude-sonnet-4.5",
  "claude-opus-4-8": "claude-opus-4.8",
  "claude-opus-4-7": "claude-opus-4.7",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-1": "claude-opus-4.5",
  "claude-opus-4": "claude-opus-4.5",
  "claude-3-opus": "claude-opus-4.5",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  // claude-sonnet-4 已經從 Copilot 下架，送過去會拿到
  // 400 model_not_supported，所以要對到還活著的
  "claude-sonnet-4": "claude-sonnet-4.5",
  "claude-3-7-sonnet": "claude-sonnet-4.5",
  "claude-3-5-sonnet": "claude-sonnet-4.5",
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-3-5-haiku": "claude-haiku-4.5",
  "claude-3-haiku": "claude-haiku-4.5",
};

// 已經警告過的 model，避免每個請求都刷一行
const warnedModels = new Set();

// ── 依上游即時清單解析 ──────────────────────────────────────
// 硬寫對照表一定會過期（Copilot 下架 sonnet-4、加上 opus-4.7/4.8 就是實例）。
// 這裡改成：先看上游有沒有一模一樣的，沒有就在同一階裡挑版號最高的。

function classifyTier(base) {
  if (base.includes("haiku")) return "haiku";
  if (base.includes("opus")) return "opus";
  if (base.includes("sonnet")) return "sonnet";
  // fable 是快速階，Copilot 沒有對應，歸到 sonnet
  if (base.includes("fable")) return "sonnet";
  return null;
}

// claude-opus-4.8 → [4, 8]；claude-sonnet-5 → [5]
function versionKey(id) {
  const m = id.match(/(\d+(?:\.\d+)*)\s*$/);
  if (!m) return [0];
  return m[1].split(".").map(Number);
}

function compareVersion(a, b) {
  const va = versionKey(a);
  const vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d !== 0) return d; // 降冪
  }
  return 0;
}

// availableIds 為上游 GET /models 回來的 id 陣列
function resolveModel(requested, availableIds) {
  const available = new Set(availableIds);

  // 1. 上游本來就有這個名字（含 claude-sonnet-5、claude-opus-4.6 這類短名）
  if (available.has(requested)) return requested;

  const base = stripDateSuffix(requested);
  if (available.has(base)) return base;

  // 2. 靜態表的目標還活著就用它
  const mapped = FALLBACK_MODEL_MAP[base];
  if (mapped && available.has(mapped)) return mapped;

  // 3. 同一階裡挑版號最高的
  const tier = classifyTier(base);
  if (tier) {
    const candidates = availableIds
      .filter((id) => id.startsWith("claude-") && classifyTier(id) === tier)
      .sort(compareVersion);
    if (candidates.length > 0) return candidates[0];
  }

  return null; // 交給呼叫端決定預設
}

const DEFAULT_MODEL = "claude-sonnet-4.5";

// 去掉尾端的日期／變體後綴：
//   claude-sonnet-4-5-20250929 → claude-sonnet-4-5
//   claude-fable-5[1m]         → claude-fable-5   （Claude Code 的 1M context 變體）
function stripDateSuffix(model) {
  return model
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

// availableIds 有給就依即時清單解析，沒給就退回靜態表。
function mapModel(anthropicModel, availableIds = null) {
  if (!anthropicModel) return DEFAULT_MODEL;

  if (Array.isArray(availableIds) && availableIds.length > 0) {
    const resolved = resolveModel(anthropicModel, availableIds);
    if (resolved) {
      warnIfDowngraded(anthropicModel, resolved);
      return resolved;
    }
    // 非 claude 的（gpt-*/gemini-*）原樣送出，讓上游自己拒
    if (!stripDateSuffix(anthropicModel).startsWith("claude-")) return anthropicModel;
    warnIfDowngraded(anthropicModel, DEFAULT_MODEL);
    return DEFAULT_MODEL;
  }

  // ── 以下是拿不到上游清單時的退路 ──

  const base = stripDateSuffix(anthropicModel);
  if (FALLBACK_MODEL_MAP[base]) return FALLBACK_MODEL_MAP[base];

  // 已經是 Copilot 短名（含小數點）就直接放行
  if (anthropicModel.includes(".")) return anthropicModel;

  if (base.startsWith("claude-")) {
    warnIfDowngraded(anthropicModel, DEFAULT_MODEL);
    return DEFAULT_MODEL;
  }
  return anthropicModel;
}

// 使用者在 Claude Code 選了某個模型、實際跑的卻是別的，沒有提示的話
// 根本看不出來（實測就發生過：選 Fable 5 但跑 sonnet-4.5）。
function warnIfDowngraded(requested, actual) {
  if (requested === actual) return;
  const key = `${requested}→${actual}`;
  if (warnedModels.has(key)) return;
  warnedModels.add(key);
  console.warn(`⚠️  Copilot 沒有 ${requested}，改用 ${actual}。可用清單見 GET /v1/models`);
}

// ── Content block → OpenAI content ──────────────────────────

function imageBlockToOpenAI(block) {
  const src = block.source || {};
  if (src.type === "url") {
    return { type: "image_url", image_url: { url: src.url } };
  }
  // base64
  const mediaType = src.media_type || "image/png";
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${src.data || ""}` },
  };
}

// tool_result 的 content 可以是字串或 block 陣列，OpenAI 的 tool message
// 只吃字串，所以要攤平。
function flattenToolResultContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block?.type === "text") {
      parts.push(block.text || "");
    } else if (block?.type === "image") {
      // OpenAI 的 tool message 不支援圖片，只能標註
      parts.push("[image omitted: tool results cannot carry images upstream]");
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

// 把 Anthropic 的 system（字串或 block 陣列）攤成單一字串
function flattenSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text || "" : ""))
    .filter(Boolean)
    .join("\n\n");
}

// ── Messages 轉譯 ────────────────────────────────────────────

// 一則 Anthropic message 可能拆成多則 OpenAI message
// （user + tool_result → tool messages；assistant + tool_use → tool_calls）
function convertMessage(msg) {
  const out = [];
  const role = msg.role;
  const content = msg.content;

  // 純字串 content 最單純
  if (typeof content === "string") {
    out.push({ role, content });
    return out;
  }

  if (!Array.isArray(content)) {
    out.push({ role, content: "" });
    return out;
  }

  const textParts = [];
  const mediaParts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    switch (block.type) {
      case "text":
        textParts.push(block.text || "");
        break;

      case "image":
        mediaParts.push(imageBlockToOpenAI(block));
        break;

      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
        break;

      case "tool_result":
        toolResults.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: flattenToolResultContent(block.content),
        });
        break;

      case "thinking":
      case "redacted_thinking":
        // Copilot 上游不支援 extended thinking，丟掉不往上送
        break;

      case "document":
        // 文件 block 沒有 OpenAI 對應，退化成文字說明
        textParts.push("[document omitted: not supported upstream]");
        break;

      default:
        break;
    }
  }

  // tool_result 必須是獨立的 tool message，且要排在其他內容之前
  // （OpenAI 要求 tool message 緊跟在帶 tool_calls 的 assistant message 之後）
  out.push(...toolResults);

  const hasText = textParts.some((t) => t.length > 0);

  if (role === "assistant") {
    const assistantMsg = { role: "assistant" };
    assistantMsg.content = hasText ? textParts.join("") : null;
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    // 空的 assistant message 不送（例如只有 thinking block）
    if (assistantMsg.content != null || assistantMsg.tool_calls) {
      out.push(assistantMsg);
    }
  } else if (hasText || mediaParts.length > 0) {
    // user message：有圖片時用 multipart 格式，否則用純字串
    if (mediaParts.length > 0) {
      const parts = [];
      if (hasText) parts.push({ type: "text", text: textParts.join("") });
      parts.push(...mediaParts);
      out.push({ role: "user", content: parts });
    } else {
      out.push({ role: "user", content: textParts.join("") });
    }
  }

  return out;
}

function convertTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;

  const converted = [];
  for (const tool of tools) {
    // Anthropic 內建的伺服器端工具（web_search 等）帶 type 但沒有 input_schema，
    // Copilot 不支援，直接跳過。
    if (!tool?.name || !tool?.input_schema) continue;
    converted.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema,
      },
    });
  }
  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  switch (toolChoice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: toolChoice.name } };
    case "none":
      return "none";
    default:
      return undefined;
  }
}

// Anthropic Messages request → OpenAI Chat Completions request
function anthropicToOpenAI(body, availableIds = null) {
  const messages = [];

  const system = flattenSystem(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const msg of body.messages || []) {
    messages.push(...convertMessage(msg));
  }

  const openaiBody = {
    model: mapModel(body.model, availableIds),
    messages,
    stream: body.stream === true,
  };

  // max_tokens 在 Anthropic 是必填，OpenAI 是選填
  if (typeof body.max_tokens === "number") openaiBody.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") openaiBody.temperature = body.temperature;
  if (typeof body.top_p === "number") openaiBody.top_p = body.top_p;

  // top_k 沒有 OpenAI 對應，忽略

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    openaiBody.stop = body.stop_sequences;
  }

  const tools = convertTools(body.tools);
  if (tools) {
    openaiBody.tools = tools;
    const choice = convertToolChoice(body.tool_choice);
    if (choice !== undefined) openaiBody.tool_choice = choice;
  }

  if (openaiBody.stream) {
    // 要 usage 才能回報 output_tokens
    openaiBody.stream_options = { include_usage: true };
  }

  return openaiBody;
}

// ── 回應轉譯 ─────────────────────────────────────────────────

const STOP_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

function mapStopReason(finishReason, hasToolUse) {
  if (hasToolUse) return "tool_use";
  if (!finishReason) return "end_turn";
  return STOP_REASON_MAP[finishReason] || "end_turn";
}

function safeParseJson(str) {
  if (typeof str !== "string" || str.trim() === "") return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// OpenAI 非串流回應 → Anthropic Messages 回應
function openAIToAnthropic(openaiRes, requestedModel) {
  const choice = openaiRes?.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];

  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    // 少數上游會回 multipart
    for (const part of message.content) {
      if (part?.type === "text" && part.text) {
        content.push({ type: "text", text: part.text });
      }
    }
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${Math.random().toString(36).slice(2, 14)}`,
      name: call.function?.name || "",
      input: safeParseJson(call.function?.arguments),
    });
  }

  // Anthropic 規定 content 不可為空陣列
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = openaiRes?.usage || {};

  return {
    id: openaiRes?.id ? `msg_${openaiRes.id}` : `msg_${Math.random().toString(36).slice(2, 14)}`,
    type: "message",
    role: "assistant",
    model: requestedModel || openaiRes?.model || DEFAULT_MODEL,
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ── Token 估算 ───────────────────────────────────────────────
// Copilot 沒有 count_tokens 端點，只能估。約 4 char / token，
// 圖片一律當 1500 token 算。Claude Code 顯示的 context 用量會有誤差。

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1500;

function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateTokens(body) {
  let chars = 0;
  let images = 0;

  const system = flattenSystem(body.system);
  chars += system.length;

  for (const msg of body.messages || []) {
    const content = msg.content;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      switch (block.type) {
        case "text":
          chars += (block.text || "").length;
          break;
        case "image":
          images++;
          break;
        case "tool_use":
          chars += (block.name || "").length + JSON.stringify(block.input ?? {}).length;
          break;
        case "tool_result":
          chars += flattenToolResultContent(block.content).length;
          break;
        case "thinking":
          chars += (block.thinking || "").length;
          break;
        default:
          break;
      }
    }
  }

  // 工具定義也吃 context
  for (const tool of body.tools || []) {
    if (!tool?.name) continue;
    chars += (tool.name || "").length + (tool.description || "").length;
    chars += JSON.stringify(tool.input_schema ?? {}).length;
  }

  // 每則 message 的角色標記約 4 token
  const messageOverhead = (body.messages || []).length * 4;

  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE + messageOverhead;
}

// ── 錯誤格式 ─────────────────────────────────────────────────

const STATUS_TO_ERROR_TYPE = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  502: "api_error",
  503: "overloaded_error",
  529: "overloaded_error",
};

function anthropicError(status, message) {
  return {
    type: "error",
    error: {
      type: STATUS_TO_ERROR_TYPE[status] || "api_error",
      message: message || "Unknown error",
    },
  };
}

export {
  anthropicToOpenAI,
  openAIToAnthropic,
  estimateTokens,
  estimateTextTokens,
  anthropicError,
  mapModel,
  resolveModel,
  classifyTier,
  stripDateSuffix,
  FALLBACK_MODEL_MAP,
  mapStopReason,
  flattenSystem,
  flattenToolResultContent,
  convertMessage,
  convertTools,
  convertToolChoice,
  safeParseJson,
  DEFAULT_MODEL,
};

// 端到端測試 — 用本機 mock 上游，不需要 GitHub 憑證，不會打到真的 Copilot API
//
// mock 上游同時服務兩個端點，跟真的 Copilot 一樣：
//   /v1/messages       原生 Anthropic（Claude 模型走這條，passthrough）
//   /chat/completions  OpenAI（gpt/gemini 走這條，需要轉譯）
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// 必須在 import index.js 之前設好，index.js 在載入時就會讀。
//
// 這幾個也要明確清掉：index.js 會呼叫 dotenv config()，開發機的 .env 若設了
// COPILOT_THINKING_EFFORT 就會滲進測試，讓「沒要求 thinking 時不該加參數」
// 這類斷言隨開發機設定而變。dotenv 不覆蓋已存在的 key，所以設空字串就擋住了。
process.env.PROXY_API_KEY = "test-key-123";
process.env.COPILOT_THINKING_EFFORT = "";
process.env.COPILOT_DEFAULT_MODEL = "";

const { app } = await import("../index.js");
const { state } = await import("../token-manager.js");

const API_KEY = "test-key-123";

// ── Mock 上游 ────────────────────────────────────────────────

// 照著真上游的形狀建。關鍵欄位：
//   supported_endpoints  決定 proxy 走 passthrough 還是轉譯
//   supports.adaptive_thinking / reasoning_effort  決定能不能調思考程度
function anthropicModel(id, { efforts = null, adaptive = false } = {}) {
  const supports = { tool_calls: true, vision: true, streaming: true };
  if (adaptive) {
    supports.adaptive_thinking = true;
    supports.min_thinking_budget = 1024;
    supports.max_thinking_budget = 32000;
  }
  if (efforts) supports.reasoning_effort = efforts;
  return {
    id,
    vendor: "Anthropic",
    supported_endpoints: ["/v1/messages", "/chat/completions"],
    capabilities: {
      limits: { max_context_window_tokens: 264000, max_output_tokens: 64000 },
      supports,
    },
  };
}

const UPSTREAM_MODELS = [
  // 有 thinking + 完整 effort 階梯
  anthropicModel("claude-sonnet-5", {
    adaptive: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  anthropicModel("claude-opus-4.8", {
    adaptive: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  }),
  // 有 thinking，但 effort 階梯缺 xhigh（真上游的 opus-4.6 就是這樣）
  anthropicModel("claude-opus-4.6", {
    adaptive: true,
    efforts: ["low", "medium", "high", "max"],
  }),
  // 完全沒有 thinking / effort 能力
  anthropicModel("claude-sonnet-4.5"),
  anthropicModel("claude-opus-4.5"),
  anthropicModel("claude-haiku-4.5"),
  // 非 Claude：只有 /chat/completions，必須走轉譯層
  {
    id: "gpt-4o",
    vendor: "Azure OpenAI",
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
      supports: { tool_calls: true, vision: true, streaming: true },
    },
  },
];

// 記錄 client 導致的上游請求（GET /models 不算）
let lastUpstreamRequest = null;
// 兩個端點各自的 handler，測試各自覆寫
let nativeHandler = null;
let chatHandler = null;

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // proxy 自己去問的清單，不該蓋掉 lastUpstreamRequest
    if (req.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: UPSTREAM_MODELS }));
    }

    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      // 保留空物件
    }
    lastUpstreamRequest = { url: req.url, method: req.method, headers: req.headers, body };

    // 照真上游的行為驗參數，這樣測試才抓得到 proxy 送錯東西
    if (req.url === "/v1/messages") {
      const model = UPSTREAM_MODELS.find((m) => m.id === body.model);
      if (!model) return upstreamError(res, 400, "The requested model is not supported.");

      const supports = model.capabilities.supports;
      if (body.thinking?.type === "enabled") {
        return upstreamError(
          res,
          400,
          '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort".'
        );
      }
      if (body.thinking && !supports.adaptive_thinking) {
        return upstreamError(res, 400, `${body.model} does not support thinking`);
      }
      const effort = body.output_config?.effort;
      if (effort) {
        if (!supports.reasoning_effort) {
          return upstreamError(
            res,
            400,
            `output_config.effort "${effort}" was provided, but model ${body.model} does not support reasoning effort`
          );
        }
        if (!supports.reasoning_effort.includes(effort)) {
          return upstreamError(res, 400, `effort "${effort}" not supported by ${body.model}`);
        }
      }
      return nativeHandler(req, res, lastUpstreamRequest);
    }

    if (req.url === "/v1/messages/count_tokens") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ input_tokens: 4242 }));
    }

    return chatHandler(req, res, lastUpstreamRequest);
  });
});

function upstreamError(res, status, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}

let proxyServer;
let baseUrl;

before(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = upstream.address().port;

  proxyServer = app.listen(0, "127.0.0.1");
  await new Promise((r) => proxyServer.once("listening", r));
  baseUrl = `http://127.0.0.1:${proxyServer.address().port}`;

  // 假裝已經授權，並把上游指向 mock server
  state.accessToken = "fake-github-access-token";
  state.copilotToken = "fake-copilot-token";
  state.copilotTokenExpiresAt = Date.now() + 3600 * 1000;
  state.apiBaseUrl = `http://127.0.0.1:${upstreamPort}`;
});

after(async () => {
  await new Promise((r) => proxyServer.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => {
  lastUpstreamRequest = null;
  nativeHandler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(nativeMessage("default")));
  };
  chatHandler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonCompletion("default")));
  };
});

// ── 回應建構工具 ─────────────────────────────────────────────

// 原生 Anthropic 回應（含 Copilot 的私有 copilot_usage 欄位）
function nativeMessage(text, extra = {}) {
  return {
    id: "msg_011CdRkeZRTH3u7XwnNE2dFY",
    type: "message",
    role: "assistant",
    model: extra.model || "claude-sonnet-5",
    content: extra.content || [{ type: "text", text }],
    stop_reason: extra.stop_reason || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: extra.cacheRead ?? 0,
      ...(extra.thinkingTokens
        ? { output_tokens_details: { thinking_tokens: extra.thinkingTokens } }
        : {}),
    },
    // Copilot 私有欄位，proxy 應該剝掉
    copilot_usage: { total_nano_aiu: 6000000, token_details: [] },
  };
}

function jsonCompletion(text, extra = {}) {
  return {
    id: "cmpl-mock",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, ...(extra.message || {}) },
        finish_reason: extra.finish_reason || "stop",
      },
    ],
    usage: extra.usage || { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function sseUpstream(res, chunks, { delay = 0 } = {}) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const send = () => {
    if (i >= chunks.length) return res.end();
    res.write(chunks[i++]);
    if (delay > 0) setTimeout(send, delay);
    else send();
  };
  send();
}

function oaChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function anthEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSSE(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (event) events.push({ event, data: data ? JSON.parse(data) : null });
  }
  return events;
}

function messagesRequest(body, { headers = {}, key = API_KEY } = {}) {
  const h = { "Content-Type": "application/json", ...headers };
  if (key !== null && !("x-api-key" in h) && !("authorization" in h)) h["x-api-key"] = key;
  return fetch(`${baseUrl}/v1/messages`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

// Claude 模型 → 走原生 passthrough
const MINIMAL = {
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
};

// 非 Claude 模型 → 走轉譯層
const TRANSLATED = {
  model: "gpt-4o",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
};

// ── 認證 ─────────────────────────────────────────────────────

describe("/v1/messages 認證", () => {
  test("x-api-key 可以通過（Claude Code 用 ANTHROPIC_API_KEY 時送這個）", async () => {
    const res = await messagesRequest(MINIMAL, { headers: { "x-api-key": API_KEY } });
    assert.equal(res.status, 200);
  });

  test("Authorization: Bearer 也可以通過（ANTHROPIC_AUTH_TOKEN）", async () => {
    const res = await messagesRequest(MINIMAL, { headers: { authorization: `Bearer ${API_KEY}` } });
    assert.equal(res.status, 200);
  });

  test("錯誤的 key 回 401 且是 Anthropic 錯誤格式", async () => {
    const res = await messagesRequest(MINIMAL, { headers: { "x-api-key": "wrong" } });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.type, "error");
    assert.equal(json.error.type, "authentication_error");
  });

  test("完全沒帶 key 回 401", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(MINIMAL),
    });
    assert.equal(res.status, 401);
  });
});

describe("回歸：OpenAI 端點的認證行為沒被改動", () => {
  test("/v1/chat/completions 仍然接受 Authorization: Bearer", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
  });

  test("/v1/chat/completions 不接受 x-api-key（維持 233eef1 的 revert）", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.error.message, "Invalid API key");
    assert.equal(json.type, undefined);
  });

  test("/v1/chat/completions 回應原樣轉發，不做 Anthropic 轉譯", async () => {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const json = await res.json();
    assert.equal(json.object, "chat.completion");
    // 送到 /chat/completions，不是原生端點
    assert.equal(lastUpstreamRequest.url, "/chat/completions");
  });
});

// ── 請求驗證 ─────────────────────────────────────────────────

describe("/v1/messages 請求驗證", () => {
  test("缺 max_tokens 回 400", async () => {
    const res = await messagesRequest({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.type, "invalid_request_error");
    assert.match(json.error.message, /max_tokens/);
  });

  test("messages 為空陣列回 400", async () => {
    const res = await messagesRequest({ model: "m", max_tokens: 10, messages: [] });
    assert.equal(res.status, 400);
  });

  test("messages 不是陣列回 400", async () => {
    const res = await messagesRequest({ model: "m", max_tokens: 10, messages: "hi" });
    assert.equal(res.status, 400);
  });
});

// ── 原生 passthrough（Claude 模型）───────────────────────────

describe("原生 passthrough — 路由", () => {
  test("Claude 模型送到上游的 /v1/messages，不是 /chat/completions", async () => {
    await messagesRequest(MINIMAL);
    assert.equal(lastUpstreamRequest.url, "/v1/messages");
  });

  test("body 保持 Anthropic 格式，沒有被轉成 OpenAI", async () => {
    await messagesRequest({
      ...MINIMAL,
      system: [{ type: "text", text: "be terse" }],
    });
    const b = lastUpstreamRequest.body;
    // system 應該還是 Anthropic 的 top-level 欄位，不是塞進 messages
    assert.deepEqual(b.system, [{ type: "text", text: "be terse" }]);
    assert.equal(b.messages.length, 1);
    assert.equal(b.messages[0].role, "user");
    assert.equal(b.max_tokens, 100);
  });

  test("只有 model 被改寫成上游的 id", async () => {
    await messagesRequest(MINIMAL);
    assert.equal(lastUpstreamRequest.body.model, "claude-sonnet-4.5");
  });

  test("tool_use / tool_result 原樣送出，不轉成 tool_calls", async () => {
    await messagesRequest({
      ...MINIMAL,
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "body" }],
        },
      ],
      tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
    });
    const msgs = lastUpstreamRequest.body.messages;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
    assert.equal(msgs[1].content[0].type, "tool_use");
    assert.equal(msgs[2].content[0].type, "tool_result");
    // 工具定義也保持 Anthropic 形狀
    assert.equal(lastUpstreamRequest.body.tools[0].input_schema.type, "object");
  });

  test("cache_control 原樣送出（prompt caching 不再被丟掉）", async () => {
    await messagesRequest({
      ...MINIMAL,
      system: [{ type: "text", text: "long prompt", cache_control: { type: "ephemeral" } }],
    });
    assert.deepEqual(lastUpstreamRequest.body.system[0].cache_control, { type: "ephemeral" });
  });

  test("帶上 anthropic-version header", async () => {
    await messagesRequest(MINIMAL, {
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    });
    assert.equal(lastUpstreamRequest.headers["anthropic-version"], "2023-06-01");
  });

  test("client 沒給 anthropic-version 時補預設值", async () => {
    await messagesRequest(MINIMAL);
    assert.equal(lastUpstreamRequest.headers["anthropic-version"], "2023-06-01");
  });

  test("anthropic-beta 有給就轉發", async () => {
    await messagesRequest(MINIMAL, {
      headers: { "x-api-key": API_KEY, "anthropic-beta": "context-1m-2025-08-07" },
    });
    assert.equal(lastUpstreamRequest.headers["anthropic-beta"], "context-1m-2025-08-07");
  });

  test("Copilot 需要的 header 仍然帶著", async () => {
    await messagesRequest(MINIMAL);
    const h = lastUpstreamRequest.headers;
    assert.equal(h.authorization, "Bearer fake-copilot-token");
    assert.equal(h["editor-version"], "vscode/1.96.2");
    assert.equal(h["x-initiator"], "user");
  });

  test("有 tools 時 X-Initiator 變成 agent", async () => {
    await messagesRequest({
      ...MINIMAL,
      tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
    });
    assert.equal(lastUpstreamRequest.headers["x-initiator"], "agent");
  });

  test("有圖片時帶 Copilot-Vision-Request", async () => {
    await messagesRequest({
      ...MINIMAL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what?" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } },
          ],
        },
      ],
    });
    assert.equal(lastUpstreamRequest.headers["copilot-vision-request"], "true");
  });
});

describe("原生 passthrough — 回應", () => {
  test("上游回應原樣轉發，含真實 usage", async () => {
    nativeHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(nativeMessage("Hello", { cacheRead: 1234 })));
    };
    const json = await (await messagesRequest(MINIMAL)).json();
    assert.equal(json.type, "message");
    assert.equal(json.id, "msg_011CdRkeZRTH3u7XwnNE2dFY");
    assert.deepEqual(json.content, [{ type: "text", text: "Hello" }]);
    // 真實 usage，不是估算
    assert.equal(json.usage.input_tokens, 10);
    assert.equal(json.usage.cache_read_input_tokens, 1234);
  });

  test("剝掉 Copilot 私有的 copilot_usage 欄位", async () => {
    const json = await (await messagesRequest(MINIMAL)).json();
    assert.equal(json.copilot_usage, undefined);
    // 其他欄位不受影響
    assert.equal(json.type, "message");
  });

  test("thinking block 原樣回傳（轉譯層做不到這件事）", async () => {
    nativeHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          nativeMessage("", {
            content: [
              { type: "thinking", thinking: "let me work this out...", signature: "sig" },
              { type: "text", text: "391" },
            ],
            thinkingTokens: 29,
          })
        )
      );
    };
    const json = await (await messagesRequest({ ...MINIMAL, model: "claude-sonnet-5" })).json();
    assert.equal(json.content[0].type, "thinking");
    assert.equal(json.content[0].thinking, "let me work this out...");
    assert.equal(json.usage.output_tokens_details.thinking_tokens, 29);
  });

  test("上游錯誤原樣轉發（已經是 Anthropic 格式）", async () => {
    nativeHandler = (req, res) => upstreamError(res, 429, "rate limited");
    const res = await messagesRequest(MINIMAL);
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.type, "error");
    assert.equal(json.error.message, "rate limited");
  });
});

describe("原生 passthrough — 思考程度", () => {
  test("thinking.enabled 換成 adaptive（上游不吃 enabled）", async () => {
    const res = await messagesRequest({
      ...MINIMAL,
      model: "claude-sonnet-5",
      thinking: { type: "enabled", budget_tokens: 8000 },
    });
    assert.equal(res.status, 200, "不該被上游以 thinking.type.enabled 擋掉");
    assert.deepEqual(lastUpstreamRequest.body.thinking, { type: "adaptive" });
  });

  test("budget_tokens 按比例折成 effort 檔位", async () => {
    const cases = [
      [1000, "low"], // 3% of 32000
      [5000, "medium"], // 16%
      [10000, "high"], // 31%
      [20000, "xhigh"], // 63%
      [30000, "max"], // 94%
    ];
    for (const [budget, expected] of cases) {
      await messagesRequest({
        ...MINIMAL,
        model: "claude-sonnet-5",
        thinking: { type: "enabled", budget_tokens: budget },
      });
      assert.equal(
        lastUpstreamRequest.body.output_config.effort,
        expected,
        `budget=${budget} 應該對到 ${expected}`
      );
    }
  });

  test("client 直接給 output_config.effort 就照用", async () => {
    const res = await messagesRequest({
      ...MINIMAL,
      model: "claude-opus-4.8",
      output_config: { effort: "xhigh" },
    });
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamRequest.body.output_config.effort, "xhigh");
    // effort 要生效必須同時有 adaptive thinking
    assert.deepEqual(lastUpstreamRequest.body.thinking, { type: "adaptive" });
  });

  test("模型不支援某個檔位時往下收斂，不是硬送去撞 400", async () => {
    // opus-4.6 的階梯沒有 xhigh
    const res = await messagesRequest({
      ...MINIMAL,
      model: "claude-opus-4.6",
      output_config: { effort: "xhigh" },
    });
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamRequest.body.output_config.effort, "high");
  });

  test("模型完全不支援 effort 時剝掉（否則上游 400）", async () => {
    const res = await messagesRequest({
      ...MINIMAL,
      model: "claude-sonnet-4.5",
      output_config: { effort: "high" },
    });
    assert.equal(res.status, 200, "不該撞到 does not support reasoning effort");
    assert.equal(lastUpstreamRequest.body.output_config, undefined);
  });

  test("模型不支援 thinking 時整個剝掉", async () => {
    const res = await messagesRequest({
      ...MINIMAL,
      model: "claude-haiku-4.5",
      thinking: { type: "enabled", budget_tokens: 4000 },
    });
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamRequest.body.thinking, undefined);
    assert.equal(lastUpstreamRequest.body.output_config, undefined);
  });

  test("output_config 的其他欄位不會被連帶刪掉", async () => {
    await messagesRequest({
      ...MINIMAL,
      model: "claude-sonnet-4.5",
      output_config: { effort: "high", something_else: 1 },
    });
    assert.deepEqual(lastUpstreamRequest.body.output_config, { something_else: 1 });
  });

  test("沒要求 thinking 時不會自己加上去", async () => {
    await messagesRequest({ ...MINIMAL, model: "claude-sonnet-5" });
    assert.equal(lastUpstreamRequest.body.thinking, undefined);
    assert.equal(lastUpstreamRequest.body.output_config, undefined);
  });
});

describe("原生 passthrough — 串流", () => {
  test("SSE 位元組原樣轉發，含 thinking_delta", async () => {
    nativeHandler = (req, res) => {
      sseUpstream(res, [
        anthEvent("message_start", {
          type: "message_start",
          message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 19, output_tokens: 0 } },
        }),
        anthEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        anthEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "6*7 is 42" } }),
        anthEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthEvent("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
        anthEvent("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "42" } }),
        anthEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
        anthEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 87, output_tokens_details: { thinking_tokens: 29 } } }),
        anthEvent("message_stop", { type: "message_stop" }),
      ]);
    };

    const res = await messagesRequest({ ...MINIMAL, model: "claude-sonnet-5", stream: true });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const events = parseSSE(await res.text());

    assert.deepEqual(events.map((e) => e.event), [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // thinking_delta 原封不動 —— 轉譯層做不到
    const think = events.find((e) => e.data?.delta?.type === "thinking_delta");
    assert.equal(think.data.delta.thinking, "6*7 is 42");
    const md = events.find((e) => e.event === "message_delta");
    assert.equal(md.data.usage.output_tokens_details.thinking_tokens, 29);
  });

  test("上游沒送 message_stop 時補上（否則 client 會一直等）", async () => {
    nativeHandler = (req, res) => {
      sseUpstream(res, [
        anthEvent("message_start", { type: "message_start", message: { id: "m", content: [] } }),
        anthEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      ]);
    };
    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    assert.equal(events.at(-1).event, "message_stop");
  });

  test("上游中途斷線時補 error + message_stop", async () => {
    nativeHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(anthEvent("message_start", { type: "message_start", message: { id: "m", content: [] } }));
      setTimeout(() => res.destroy(), 20);
    };
    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    const names = events.map((e) => e.event);
    assert.ok(names.includes("error"), names.join(","));
    assert.equal(names.at(-1), "message_stop");
  });

  test("串流時上游回非 200 → 錯誤走 JSON 而不是 SSE", async () => {
    nativeHandler = (req, res) => upstreamError(res, 403, "no access");
    const res = await messagesRequest({ ...MINIMAL, stream: true });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.message, "no access");
  });
});

// ── 轉譯層（非 Claude 模型）─────────────────────────────────

describe("轉譯層 — gpt/gemini 仍然走 /chat/completions", () => {
  test("gpt-4o 送到 /chat/completions，body 轉成 OpenAI 格式", async () => {
    await messagesRequest({ ...TRANSLATED, system: "be terse" });
    assert.equal(lastUpstreamRequest.url, "/chat/completions");
    const b = lastUpstreamRequest.body;
    assert.equal(b.messages[0].role, "system");
    assert.equal(b.messages[0].content, "be terse");
    assert.equal(b.messages[1].role, "user");
  });

  test("回應轉成 Anthropic Messages 格式", async () => {
    chatHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonCompletion("from gpt")));
    };
    const json = await (await messagesRequest(TRANSLATED)).json();
    assert.equal(json.type, "message");
    assert.deepEqual(json.content, [{ type: "text", text: "from gpt" }]);
    assert.equal(json.stop_reason, "end_turn");
    assert.deepEqual(json.usage, { input_tokens: 10, output_tokens: 5 });
  });

  test("tool_result 轉成 role:tool", async () => {
    await messagesRequest({
      ...TRANSLATED,
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_x", name: "Read", input: { path: "a.txt" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_x", content: "file body" }],
        },
      ],
      tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
    });
    const msgs = lastUpstreamRequest.body.messages;
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "tool"]);
    assert.equal(msgs[2].tool_call_id, "call_x");
  });

  test("tool_calls 轉成 tool_use block", async () => {
    chatHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          jsonCompletion(null, {
            message: {
              content: null,
              tool_calls: [
                { id: "call_x", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
              ],
            },
            finish_reason: "tool_calls",
          })
        )
      );
    };
    const json = await (await messagesRequest(TRANSLATED)).json();
    assert.equal(json.stop_reason, "tool_use");
    assert.equal(json.content[0].type, "tool_use");
    assert.deepEqual(json.content[0].input, { path: "a.txt" });
  });

  test("串流走轉譯狀態機，產生合法 Anthropic 事件", async () => {
    chatHandler = (req, res) => {
      sseUpstream(res, [
        oaChunk({ choices: [{ delta: { content: "Hello" } }] }),
        oaChunk({ choices: [{ delta: { content: " there" } }] }),
        oaChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]);
    };
    const events = parseSSE(await (await messagesRequest({ ...TRANSLATED, stream: true })).text());
    assert.deepEqual(events.map((e) => e.event), [
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    assert.equal(text, "Hello there");
  });

  test("上游錯誤轉成 Anthropic 錯誤格式", async () => {
    chatHandler = (req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    };
    const res = await messagesRequest(TRANSLATED);
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.error.type, "rate_limit_error");
  });
});

// ── count_tokens ─────────────────────────────────────────────

describe("/v1/messages/count_tokens", () => {
  test("用上游原生端點回真值，不是估算", async () => {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    // mock 上游固定回 4242；估算值不可能剛好是這個數字
    assert.equal(json.input_tokens, 4242);
    assert.equal(lastUpstreamRequest.url, "/v1/messages/count_tokens");
  });

  test("送給上游的 model 是對照後的 id", async () => {
    await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(lastUpstreamRequest.body.model, "claude-haiku-4.5");
  });

  test("messages 不是陣列回 400", async () => {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ model: "m" }),
    });
    assert.equal(res.status, 400);
  });

  test("需要認證", async () => {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(res.status, 401);
  });
});

// ── 模型解析 ─────────────────────────────────────────────────

describe("模型解析", () => {
  test("/v1/models 回上游的真實清單，不是硬寫的", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const ids = (await res.json()).data.map((m) => m.id);
    assert.ok(ids.includes("claude-sonnet-5"), ids.join(","));
    assert.ok(ids.includes("claude-haiku-4.5"), ids.join(","));
    assert.ok(!ids.includes("claude-sonnet-4"), ids.join(","));
  });

  test("/v1/models 帶上 context window 等能力資訊", async () => {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const m = (await res.json()).data.find((x) => x.id === "claude-sonnet-5");
    assert.equal(m.context_window, 264000);
    assert.equal(m.supports.tool_calls, true);
    assert.equal(m.owned_by, "anthropic");
  });

  test("Claude Code 送 claude-sonnet-5 時原樣送上游（不再降級）", async () => {
    await messagesRequest({ ...MINIMAL, model: "claude-sonnet-5" });
    assert.equal(lastUpstreamRequest.body.model, "claude-sonnet-5");
  });

  test("claude-opus-5 對到上游最好的 opus", async () => {
    await messagesRequest({ ...MINIMAL, model: "claude-opus-5" });
    assert.equal(lastUpstreamRequest.body.model, "claude-opus-4.8");
  });

  test("已下架的 claude-sonnet-4 不會被原樣送出（否則上游回 400）", async () => {
    const res = await messagesRequest({ ...MINIMAL, model: "claude-sonnet-4-20250514" });
    assert.equal(res.status, 200, "應該成功，不該撞到 model_not_supported");
    assert.equal(lastUpstreamRequest.body.model, "claude-sonnet-4.5");
  });

  test("haiku 對到上游真的有的 claude-haiku-4.5", async () => {
    await messagesRequest({ ...MINIMAL, model: "claude-3-5-haiku-20241022" });
    assert.equal(lastUpstreamRequest.body.model, "claude-haiku-4.5");
  });

  test("送上游的 model 一定在清單內", async () => {
    const allowed = new Set(UPSTREAM_MODELS.map((m) => m.id));
    for (const m of [
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-4-20250514",
      "claude-3-opus-20240229",
    ]) {
      const res = await messagesRequest({ ...MINIMAL, model: m });
      assert.equal(res.status, 200, `${m} 應該成功`);
      assert.ok(
        allowed.has(lastUpstreamRequest.body.model),
        `${m} → ${lastUpstreamRequest.body.model} 不在上游清單裡`
      );
    }
  });

  test("/admin/model-map 標示 live 並列出可用清單", async () => {
    const res = await fetch(`${baseUrl}/admin/model-map`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const json = await res.json();
    assert.equal(json.live, true);
    assert.ok(json.available.includes("claude-sonnet-5"));
  });
});

// ── CORS / 其他端點 ──────────────────────────────────────────

describe("CORS 與管理端點", () => {
  test("preflight 放行 Anthropic SDK 需要的 header", async () => {
    const res = await fetch(`${baseUrl}/v1/messages`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    const allowed = res.headers.get("access-control-allow-headers").toLowerCase();
    for (const h of ["x-api-key", "anthropic-version", "anthropic-beta"]) {
      assert.ok(allowed.includes(h), `missing ${h}`);
    }
  });

  test("/health 帶版本", async () => {
    const json = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(json.authorized, true);
    assert.equal(json.version, "1.2.0");
  });

  test("/admin/status 列出端點", async () => {
    const res = await fetch(`${baseUrl}/admin/status`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const json = await res.json();
    assert.equal(json.proxy.endpoints.anthropic, "/v1/messages");
    assert.equal(json.proxy.endpoints.openai, "/v1/chat/completions");
  });
});

// ── 伺服器端強制指定模型 ──────────────────────────────────────
// COPILOT_DEFAULT_MODEL 在載入時就讀進去了，所以這裡直接測那支純函式的規則
describe("applyModelOverride 規則", () => {
  test("沒設 override 時原樣回傳", async () => {
    const { applyModelOverride } = await import("../proxy.js");
    assert.equal(applyModelOverride("claude-fable-5"), "claude-fable-5");
  });

  test("haiku 階不被覆寫（背景小任務不該花 opus 的錢）", async () => {
    const { classifyTier, stripDateSuffix } = await import("../anthropic-adapter.js");
    // 規則本身：haiku 階要被辨識出來
    assert.equal(classifyTier(stripDateSuffix("claude-3-5-haiku-20241022")), "haiku");
    assert.equal(classifyTier(stripDateSuffix("claude-haiku-4.5")), "haiku");
    // 非 haiku 階
    for (const m of ["claude-fable-5[1m]", "claude-sonnet-5", "claude-opus-5"]) {
      assert.notEqual(classifyTier(stripDateSuffix(m)), "haiku", m);
    }
  });
});

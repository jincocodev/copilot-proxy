// 端到端測試 — 用本機 mock 上游，不需要 GitHub 憑證，不會打到真的 Copilot API
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// 必須在 import index.js 之前設好，index.js 在載入時就會讀
process.env.PROXY_API_KEY = "test-key-123";

const { app } = await import("../index.js");
const { state } = await import("../token-manager.js");

const API_KEY = "test-key-123";

// ── Mock 上游 ────────────────────────────────────────────────

let upstreamHandler = null;
let lastUpstreamRequest = null;

const upstream = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      // 保留空物件
    }
    lastUpstreamRequest = { url: req.url, method: req.method, headers: req.headers, body };
    upstreamHandler(req, res, lastUpstreamRequest);
  });
});

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
  upstreamHandler = (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(jsonCompletion("default")));
  };
});

// ── 工具函式 ─────────────────────────────────────────────────

function jsonCompletion(text, extra = {}) {
  return {
    id: "cmpl-mock",
    object: "chat.completion",
    created: 1700000000,
    model: "claude-sonnet-4.5",
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
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
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
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: h,
    body: JSON.stringify(body),
  });
}

const MINIMAL = {
  model: "claude-sonnet-4-5-20250929",
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
    const res = await messagesRequest(MINIMAL, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
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
    // 而且是 OpenAI 的錯誤格式，不是 Anthropic 的
    const json = await res.json();
    assert.equal(json.error.message, "Invalid API key");
    assert.equal(json.type, undefined);
  });

  test("/v1/chat/completions 回應原樣轉發，不做 Anthropic 轉譯", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonCompletion("passthrough")));
    };
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    const json = await res.json();
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.content, "passthrough");
  });
});

// ── 請求驗證 ─────────────────────────────────────────────────

describe("/v1/messages 請求驗證", () => {
  test("缺 max_tokens 回 400", async () => {
    const res = await messagesRequest({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] });
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

// ── 非串流 ───────────────────────────────────────────────────

describe("/v1/messages 非串流", () => {
  test("回應是 Anthropic Messages 格式", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(jsonCompletion("Hello from Copilot")));
    };
    const res = await messagesRequest(MINIMAL);
    const json = await res.json();

    assert.equal(json.type, "message");
    assert.equal(json.role, "assistant");
    assert.match(json.id, /^msg_/);
    assert.deepEqual(json.content, [{ type: "text", text: "Hello from Copilot" }]);
    assert.equal(json.stop_reason, "end_turn");
    assert.deepEqual(json.usage, { input_tokens: 10, output_tokens: 5 });
  });

  test("回報的 model 是 client 要求的名稱，不是上游短名", async () => {
    const res = await messagesRequest(MINIMAL);
    const json = await res.json();
    assert.equal(json.model, "claude-sonnet-4-5-20250929");
  });

  test("上游收到的是對照後的短名與 OpenAI 格式", async () => {
    await messagesRequest({
      model: "claude-opus-4-5-20251101",
      max_tokens: 100,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(lastUpstreamRequest.url, "/chat/completions");
    assert.equal(lastUpstreamRequest.body.model, "claude-opus-4.5");
    assert.equal(lastUpstreamRequest.body.messages[0].role, "system");
    assert.equal(lastUpstreamRequest.body.messages[0].content, "be terse");
    assert.equal(lastUpstreamRequest.body.stream, false);
  });

  test("上游帶了 Copilot 需要的 header", async () => {
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
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
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

  test("沒圖片時不帶 Copilot-Vision-Request", async () => {
    await messagesRequest(MINIMAL);
    assert.equal(lastUpstreamRequest.headers["copilot-vision-request"], undefined);
  });

  test("工具呼叫回應轉成 tool_use block", async () => {
    upstreamHandler = (req, res) => {
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
    const res = await messagesRequest(MINIMAL);
    const json = await res.json();
    assert.equal(json.stop_reason, "tool_use");
    assert.equal(json.content.length, 1);
    assert.equal(json.content[0].type, "tool_use");
    assert.equal(json.content[0].id, "call_x");
    assert.deepEqual(json.content[0].input, { path: "a.txt" });
  });

  test("完整的 tool 往返：tool_result 被轉成 role:tool 送上游", async () => {
    await messagesRequest({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
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
    assert.equal(msgs[1].tool_calls[0].id, "call_x");
    assert.equal(msgs[2].tool_call_id, "call_x");
    assert.equal(msgs[2].content, "file body");
  });

  test("上游錯誤轉成 Anthropic 錯誤格式並保留 status", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rate limited" }));
    };
    const res = await messagesRequest(MINIMAL);
    assert.equal(res.status, 429);
    const json = await res.json();
    assert.equal(json.type, "error");
    assert.equal(json.error.type, "rate_limit_error");
  });

  test("上游 500 轉成 api_error", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    const res = await messagesRequest(MINIMAL);
    assert.equal(res.status, 500);
    const json = await res.json();
    assert.equal(json.error.type, "api_error");
  });
});

// ── 串流 ─────────────────────────────────────────────────────

describe("/v1/messages 串流", () => {
  test("文字串流的事件序列正確", async () => {
    upstreamHandler = (req, res) => {
      sseUpstream(res, [
        oaChunk({ choices: [{ delta: { role: "assistant", content: "" } }] }),
        oaChunk({ choices: [{ delta: { content: "Hello" } }] }),
        oaChunk({ choices: [{ delta: { content: " there" } }] }),
        oaChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ]);
    };

    const res = await messagesRequest({ ...MINIMAL, stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const events = parseSSE(await res.text());
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

  test("串流請求會要求上游帶 usage", async () => {
    upstreamHandler = (req, res) => sseUpstream(res, ["data: [DONE]\n\n"]);
    await messagesRequest({ ...MINIMAL, stream: true });
    assert.equal(lastUpstreamRequest.body.stream, true);
    assert.deepEqual(lastUpstreamRequest.body.stream_options, { include_usage: true });
  });

  test("message_start 立刻送出，不等上游第一個 token", async () => {
    upstreamHandler = (req, res) => {
      sseUpstream(
        res,
        [oaChunk({ choices: [{ delta: { content: "slow" } }] }), "data: [DONE]\n\n"],
        { delay: 30 }
      );
    };

    const res = await messagesRequest({ ...MINIMAL, stream: true });
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: message_start/);
    await reader.cancel();
  });

  test("串流的工具呼叫：文字後接 tool_use，index 遞增且配對完整", async () => {
    upstreamHandler = (req, res) => {
      sseUpstream(res, [
        oaChunk({ choices: [{ delta: { content: "Let me check. " } }] }),
        oaChunk({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "" } }],
              },
            },
          ],
        }),
        oaChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }],
        }),
        oaChunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
        }),
        oaChunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]);
    };

    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());

    const starts = events.filter((e) => e.event === "content_block_start");
    const stops = events.filter((e) => e.event === "content_block_stop");
    assert.deepEqual(starts.map((s) => s.data.index), [0, 1]);
    assert.deepEqual(starts.map((s) => s.data.content_block.type), ["text", "tool_use"]);
    assert.deepEqual(stops.map((s) => s.data.index), [0, 1]);

    const json = events
      .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "input_json_delta")
      .map((e) => e.data.delta.partial_json)
      .join("");
    assert.deepEqual(JSON.parse(json), { path: "a.txt" });

    const md = events.find((e) => e.event === "message_delta");
    assert.equal(md.data.delta.stop_reason, "tool_use");
  });

  test("上游把 SSE 切在 JSON 中間也能正確重組", async () => {
    const full = oaChunk({ choices: [{ delta: { content: "reassembled" } }] });
    upstreamHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // 故意切在 JSON 正中間，分兩個 TCP 封包送
      res.write(full.slice(0, 20));
      setTimeout(() => {
        res.write(full.slice(20));
        res.write(oaChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      }, 20);
    };

    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text)
      .join("");
    assert.equal(text, "reassembled");
  });

  test("上游中途斷線也會收到 content_block_stop 與 error", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(oaChunk({ choices: [{ delta: { content: "partial..." } }] }));
      // 不呼叫 end()，直接砍掉 socket
      setTimeout(() => res.destroy(), 20);
    };

    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    const names = events.map((e) => e.event);
    assert.ok(names.includes("content_block_stop"), `events: ${names.join(",")}`);
    assert.ok(names.includes("error"), `events: ${names.join(",")}`);
    assert.ok(names.indexOf("content_block_stop") < names.indexOf("error"));
  });

  test("串流時上游回非 200 → 錯誤走 JSON 而不是 SSE", async () => {
    upstreamHandler = (req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no access" }));
    };
    const res = await messagesRequest({ ...MINIMAL, stream: true });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error.type, "permission_error");
  });

  test("上游 usage 反映在 message_delta", async () => {
    upstreamHandler = (req, res) => {
      sseUpstream(res, [
        oaChunk({ choices: [{ delta: { content: "hi" } }] }),
        oaChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        oaChunk({ choices: [], usage: { prompt_tokens: 111, completion_tokens: 22 } }),
        "data: [DONE]\n\n",
      ]);
    };
    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    const md = events.find((e) => e.event === "message_delta");
    assert.deepEqual(md.data.usage, { input_tokens: 111, output_tokens: 22 });
  });

  test("上游完全沒回內容也是合法的 Anthropic 串流", async () => {
    upstreamHandler = (req, res) => sseUpstream(res, ["data: [DONE]\n\n"]);
    const events = parseSSE(await (await messagesRequest({ ...MINIMAL, stream: true })).text());
    const names = events.map((e) => e.event);
    assert.equal(names[0], "message_start");
    assert.equal(names.at(-1), "message_stop");
    assert.ok(names.includes("content_block_start"));
    assert.ok(names.includes("content_block_stop"));
  });
});

// ── count_tokens ─────────────────────────────────────────────

describe("/v1/messages/count_tokens", () => {
  test("回傳 input_tokens", async () => {
    const res = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "a".repeat(400) }] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(typeof json.input_tokens, "number");
    assert.ok(json.input_tokens >= 100);
  });

  test("不會打到上游（Copilot 沒有這個端點）", async () => {
    await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(lastUpstreamRequest, null);
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
    assert.equal(json.version, "1.1.0");
  });

  test("/admin/status 列出兩組端點", async () => {
    const res = await fetch(`${baseUrl}/admin/status`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const json = await res.json();
    assert.equal(json.proxy.endpoints.anthropic, "/v1/messages");
    assert.equal(json.proxy.endpoints.openai, "/v1/chat/completions");
  });

  test("/admin/model-map 可查單一 model 對照", async () => {
    const res = await fetch(`${baseUrl}/admin/model-map?model=claude-sonnet-4-5-20250929`, {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    const json = await res.json();
    assert.equal(json.mapped, "claude-sonnet-4.5");
  });

  test("anthropic-version header 不會導致失敗", async () => {
    const res = await messagesRequest(MINIMAL, {
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    });
    assert.equal(res.status, 200);
  });
});

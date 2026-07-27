// 轉譯層單元測試 — 不碰網路
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  anthropicToOpenAI,
  openAIToAnthropic,
  estimateTokens,
  mapModel,
  mapStopReason,
  resolveModel,
  classifyTier,
  flattenSystem,
  flattenToolResultContent,
  convertTools,
  convertToolChoice,
  safeParseJson,
  anthropicError,
} from "../anthropic-adapter.js";

import { AnthropicStreamTranslator } from "../anthropic-stream.js";

// ── SSE 解析工具 ─────────────────────────────────────────────

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

// 把 OpenAI chunk 包成 SSE 一行
function chunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function textChunk(content, finish = null) {
  return chunk({
    id: "cmpl-1",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
}

// ── Model 對照 ───────────────────────────────────────────────

describe("mapModel — 靜態退路（拿不到上游清單時）", () => {
  test("Claude 5 世代對到同階最好的 Copilot 款", () => {
    assert.equal(mapModel("claude-opus-5"), "claude-opus-4.8");
    assert.equal(mapModel("claude-sonnet-5"), "claude-sonnet-5");
    assert.equal(mapModel("claude-fable-5"), "claude-sonnet-4.5");
  });

  test("帶日期後綴的 opus 對到 Copilot 短名", () => {
    assert.equal(mapModel("claude-opus-4-5-20251101"), "claude-opus-4.5");
    assert.equal(mapModel("claude-opus-4-6-20260205"), "claude-opus-4.6");
    assert.equal(mapModel("claude-opus-4-8-20260601"), "claude-opus-4.8");
  });

  test("帶日期後綴的 sonnet 對到 Copilot 短名", () => {
    assert.equal(mapModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4.5");
    assert.equal(mapModel("claude-sonnet-4-6-20260101"), "claude-sonnet-4.6");
  });

  test("已下架的 claude-sonnet-4 不能原樣送出（會拿 400 model_not_supported）", () => {
    const mapped = mapModel("claude-sonnet-4-20250514");
    assert.notEqual(mapped, "claude-sonnet-4");
    assert.equal(mapped, "claude-sonnet-4.5");
  });

  test("haiku 對到 Copilot 真的有的 claude-haiku-4.5", () => {
    assert.equal(mapModel("claude-3-5-haiku-20241022"), "claude-haiku-4.5");
    assert.equal(mapModel("claude-haiku-4-5-20251001"), "claude-haiku-4.5");
  });

  test("-latest 後綴也要處理", () => {
    assert.equal(mapModel("claude-sonnet-4-5-latest"), "claude-sonnet-4.5");
  });

  test("已經是 Copilot 短名就原樣放行", () => {
    assert.equal(mapModel("claude-opus-4.6"), "claude-opus-4.6");
  });

  test("未知的 claude-* 退到預設", () => {
    assert.equal(mapModel("claude-nonexistent-9"), "claude-sonnet-4.5");
  });

  test("非 claude 的 model 原樣送出", () => {
    assert.equal(mapModel("gpt-4o"), "gpt-4o");
    assert.equal(mapModel("gemini-2.5-pro"), "gemini-2.5-pro");
  });

  test("空值退到預設", () => {
    assert.equal(mapModel(undefined), "claude-sonnet-4.5");
    assert.equal(mapModel(""), "claude-sonnet-4.5");
  });
});

// 實測從 GitHub Copilot Business 上游拿到的清單
const LIVE_IDS = [
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "gpt-4o",
  "gpt-5.5",
  "gemini-2.5-pro",
];

describe("mapModel — 依上游即時清單解析", () => {
  test("上游有一模一樣的就用它", () => {
    assert.equal(mapModel("claude-sonnet-5", LIVE_IDS), "claude-sonnet-5");
    assert.equal(mapModel("claude-opus-4.7", LIVE_IDS), "claude-opus-4.7");
  });

  test("未知的 opus 挑同階版號最高的", () => {
    assert.equal(mapModel("claude-opus-5", LIVE_IDS), "claude-opus-4.8");
    assert.equal(mapModel("claude-opus-9-20990101", LIVE_IDS), "claude-opus-4.8");
  });

  test("未知的 sonnet 挑同階版號最高的", () => {
    // 5 要大於 4.6，不能用字串比較
    assert.equal(mapModel("claude-sonnet-9", LIVE_IDS), "claude-sonnet-5");
  });

  test("haiku 挑 haiku，不會跑到 sonnet 去", () => {
    assert.equal(mapModel("claude-3-5-haiku-20241022", LIVE_IDS), "claude-haiku-4.5");
  });

  test("靜態表的目標還活著時優先用它，不會盲目升到同階最高", () => {
    // fable 是快速階，對到 sonnet-4.5 比升到最貴的 sonnet-5 合理
    assert.equal(mapModel("claude-fable-5", LIVE_IDS), "claude-sonnet-4.5");
    assert.equal(mapModel("claude-3-opus-20240229", LIVE_IDS), "claude-opus-4.5");
  });

  test("靜態表的目標下架時才退到同階最高", () => {
    // 清單裡故意沒有 claude-sonnet-4.5
    const ids = ["claude-sonnet-4.6", "claude-sonnet-5", "claude-haiku-4.5"];
    assert.equal(mapModel("claude-fable-5", ids), "claude-sonnet-5");
  });

  test("已下架的 sonnet-4 挑到活著的 sonnet", () => {
    const mapped = mapModel("claude-sonnet-4-20250514", LIVE_IDS);
    assert.ok(LIVE_IDS.includes(mapped));
    assert.equal(mapped, "claude-sonnet-4.5");
  });

  test("解析結果一定在上游清單裡（絕不製造 400 model_not_supported）", () => {
    const requests = [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-20250514",
      "claude-3-5-haiku-20241022",
      "claude-3-opus-20240229",
      "claude-3-7-sonnet-20250219",
    ];
    for (const r of requests) {
      const mapped = mapModel(r, LIVE_IDS);
      assert.ok(LIVE_IDS.includes(mapped), `${r} → ${mapped} 不在上游清單裡`);
    }
  });

  test("非 claude 的仍然原樣送出，讓上游自己拒", () => {
    assert.equal(mapModel("gpt-5.9-unreleased", LIVE_IDS), "gpt-5.9-unreleased");
  });

  test("清單是空陣列時退回靜態行為", () => {
    assert.equal(mapModel("claude-opus-5", []), "claude-opus-4.8");
  });
});

describe("resolveModel", () => {
  test("找不到同階的回 null，交給呼叫端決定", () => {
    assert.equal(resolveModel("claude-haiku-4-5", ["gpt-4o"]), null);
  });

  test("classifyTier 分階正確", () => {
    assert.equal(classifyTier("claude-opus-4.8"), "opus");
    assert.equal(classifyTier("claude-sonnet-5"), "sonnet");
    assert.equal(classifyTier("claude-haiku-4.5"), "haiku");
    assert.equal(classifyTier("claude-fable-5"), "sonnet");
    assert.equal(classifyTier("gpt-4o"), null);
  });
});

// ── system / content 攤平 ────────────────────────────────────

describe("flattenSystem", () => {
  test("字串直接回傳", () => {
    assert.equal(flattenSystem("be terse"), "be terse");
  });

  test("block 陣列串接（Claude Code 送的是這種）", () => {
    const out = flattenSystem([
      { type: "text", text: "You are Claude Code." },
      { type: "text", text: "Be concise." },
    ]);
    assert.equal(out, "You are Claude Code.\n\nBe concise.");
  });

  test("空值回空字串", () => {
    assert.equal(flattenSystem(undefined), "");
    assert.equal(flattenSystem(null), "");
  });
});

describe("flattenToolResultContent", () => {
  test("字串直接回傳", () => {
    assert.equal(flattenToolResultContent("file contents"), "file contents");
  });

  test("text block 陣列串接", () => {
    assert.equal(
      flattenToolResultContent([{ type: "text", text: "line1" }, { type: "text", text: "line2" }]),
      "line1\nline2"
    );
  });

  test("圖片標註為省略（OpenAI tool message 不支援圖片）", () => {
    const out = flattenToolResultContent([{ type: "image", source: { data: "abc" } }]);
    assert.match(out, /image omitted/);
  });

  test("null 回空字串", () => {
    assert.equal(flattenToolResultContent(null), "");
  });
});

// ── 請求轉譯 ─────────────────────────────────────────────────

describe("anthropicToOpenAI", () => {
  test("system 變成第一則 system message", () => {
    const out = anthropicToOpenAI({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 100,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.messages[0].role, "system");
    assert.equal(out.messages[0].content, "be terse");
    assert.equal(out.messages[1].role, "user");
    assert.equal(out.messages[1].content, "hi");
  });

  test("沒有 system 時不插入空的 system message", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "user");
  });

  test("max_tokens / temperature / top_p 帶過去", () => {
    const out = anthropicToOpenAI({
      max_tokens: 512,
      temperature: 0.3,
      top_p: 0.9,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.max_tokens, 512);
    assert.equal(out.temperature, 0.3);
    assert.equal(out.top_p, 0.9);
  });

  test("stop_sequences → stop", () => {
    const out = anthropicToOpenAI({
      max_tokens: 10,
      stop_sequences: ["\n\nHuman:"],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(out.stop, ["\n\nHuman:"]);
  });

  test("top_k 沒有 OpenAI 對應，不應出現在輸出", () => {
    const out = anthropicToOpenAI({
      max_tokens: 10,
      top_k: 40,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.top_k, undefined);
  });

  test("assistant 的 tool_use 變成 tool_calls", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        { role: "user", content: "read foo.txt" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll read it." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "foo.txt" } },
          ],
        },
      ],
    });
    const asst = out.messages[1];
    assert.equal(asst.role, "assistant");
    assert.equal(asst.content, "I'll read it.");
    assert.equal(asst.tool_calls.length, 1);
    assert.equal(asst.tool_calls[0].id, "toolu_1");
    assert.equal(asst.tool_calls[0].function.name, "Read");
    assert.deepEqual(JSON.parse(asst.tool_calls[0].function.arguments), { path: "foo.txt" });
  });

  test("user 的 tool_result 變成 role:tool message", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "hello world" }],
        },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "tool");
    assert.equal(out.messages[0].tool_call_id, "toolu_1");
    assert.equal(out.messages[0].content, "hello world");
  });

  test("多個 tool_result 拆成多則 tool message", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "a" },
            { type: "tool_result", tool_use_id: "t2", content: "b" },
          ],
        },
      ],
    });
    assert.equal(out.messages.length, 2);
    assert.deepEqual(out.messages.map((m) => m.tool_call_id), ["t1", "t2"]);
  });

  test("tool_result 排在同一則裡的文字之前（OpenAI 要求緊跟 tool_calls）", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "result" },
            { type: "text", text: "now what?" },
          ],
        },
      ],
    });
    assert.equal(out.messages[0].role, "tool");
    assert.equal(out.messages[1].role, "user");
    assert.equal(out.messages[1].content, "now what?");
  });

  test("圖片變成 image_url multipart", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    });
    const parts = out.messages[0].content;
    assert.equal(parts[0].type, "text");
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[1].image_url.url, "data:image/jpeg;base64,QUJD");
  });

  test("url 型圖片直接用 url", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://x.test/a.png" } }],
        },
      ],
    });
    assert.equal(out.messages[0].content[0].image_url.url, "https://x.test/a.png");
  });

  test("thinking block 被丟棄，不往上游送", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].content, "answer");
    assert.ok(!JSON.stringify(out).includes("secret reasoning"));
  });

  test("只有 thinking 的 assistant message 整則被略過", () => {
    const out = anthropicToOpenAI({
      max_tokens: 100,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      ],
    });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, "user");
  });

  test("stream:true 會帶 stream_options 以取得 usage", () => {
    const out = anthropicToOpenAI({
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.stream, true);
    assert.deepEqual(out.stream_options, { include_usage: true });
  });

  test("stream 未指定時為 false 且不帶 stream_options", () => {
    const out = anthropicToOpenAI({
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(out.stream, false);
    assert.equal(out.stream_options, undefined);
  });
});

describe("convertTools", () => {
  test("input_schema → function.parameters", () => {
    const out = convertTools([
      {
        name: "Read",
        description: "read a file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    assert.equal(out[0].type, "function");
    assert.equal(out[0].function.name, "Read");
    assert.equal(out[0].function.description, "read a file");
    assert.deepEqual(out[0].function.parameters.properties.path, { type: "string" });
  });

  test("沒有 input_schema 的伺服器端工具被跳過", () => {
    const out = convertTools([
      { type: "web_search_20250305", name: "web_search" },
      { name: "Read", input_schema: { type: "object" } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].function.name, "Read");
  });

  test("空陣列回 undefined", () => {
    assert.equal(convertTools([]), undefined);
    assert.equal(convertTools(undefined), undefined);
  });
});

describe("convertToolChoice", () => {
  test("auto/any/tool/none 對照", () => {
    assert.equal(convertToolChoice({ type: "auto" }), "auto");
    assert.equal(convertToolChoice({ type: "any" }), "required");
    assert.equal(convertToolChoice({ type: "none" }), "none");
    assert.deepEqual(convertToolChoice({ type: "tool", name: "Read" }), {
      type: "function",
      function: { name: "Read" },
    });
  });

  test("空值回 undefined", () => {
    assert.equal(convertToolChoice(undefined), undefined);
  });
});

// ── 回應轉譯 ─────────────────────────────────────────────────

describe("mapStopReason", () => {
  test("基本對照", () => {
    assert.equal(mapStopReason("stop", false), "end_turn");
    assert.equal(mapStopReason("length", false), "max_tokens");
    assert.equal(mapStopReason("tool_calls", false), "tool_use");
    assert.equal(mapStopReason("content_filter", false), "end_turn");
  });

  test("有 tool_use 時一律回 tool_use", () => {
    assert.equal(mapStopReason("stop", true), "tool_use");
  });

  test("未知 finish_reason 退到 end_turn", () => {
    assert.equal(mapStopReason("weird", false), "end_turn");
    assert.equal(mapStopReason(null, false), "end_turn");
  });
});

describe("openAIToAnthropic", () => {
  test("純文字回應", () => {
    const out = openAIToAnthropic(
      {
        id: "cmpl-abc",
        model: "claude-sonnet-4.5",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      },
      "claude-sonnet-4-5-20250929"
    );
    assert.equal(out.type, "message");
    assert.equal(out.role, "assistant");
    // model 要回報 client 要求的名字，不是上游的短名
    assert.equal(out.model, "claude-sonnet-4-5-20250929");
    assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
    assert.equal(out.stop_reason, "end_turn");
    assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 3 });
    assert.match(out.id, /^msg_/);
  });

  test("tool_calls 變成 tool_use block", () => {
    const out = openAIToAnthropic(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "let me look",
              tool_calls: [
                { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "claude-opus-4-5-20251101"
    );
    assert.equal(out.content.length, 2);
    assert.equal(out.content[0].type, "text");
    assert.equal(out.content[1].type, "tool_use");
    assert.equal(out.content[1].id, "call_1");
    assert.equal(out.content[1].name, "Read");
    assert.deepEqual(out.content[1].input, { path: "a.txt" });
    assert.equal(out.stop_reason, "tool_use");
  });

  test("壞掉的 arguments JSON 退成空物件而非爆掉", () => {
    const out = openAIToAnthropic({
      choices: [
        {
          message: {
            tool_calls: [{ id: "c1", function: { name: "X", arguments: "{not json" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    assert.deepEqual(out.content[0].input, {});
  });

  test("空 content 補一個空 text block（Anthropic 不接受空陣列）", () => {
    const out = openAIToAnthropic({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    });
    assert.equal(out.content.length, 1);
    assert.deepEqual(out.content[0], { type: "text", text: "" });
  });

  test("缺 usage 時補 0", () => {
    const out = openAIToAnthropic({ choices: [{ message: { content: "x" } }] });
    assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
  });

  test("finish_reason=length → max_tokens", () => {
    const out = openAIToAnthropic({
      choices: [{ message: { content: "trunc" }, finish_reason: "length" }],
    });
    assert.equal(out.stop_reason, "max_tokens");
  });
});

describe("safeParseJson", () => {
  test("合法 JSON", () => {
    assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
  });
  test("壞的 / 空的都回空物件", () => {
    assert.deepEqual(safeParseJson("{bad"), {});
    assert.deepEqual(safeParseJson(""), {});
    assert.deepEqual(safeParseJson(undefined), {});
  });
});

describe("anthropicError", () => {
  test("status 對到 Anthropic error type", () => {
    assert.equal(anthropicError(401, "x").error.type, "authentication_error");
    assert.equal(anthropicError(429, "x").error.type, "rate_limit_error");
    assert.equal(anthropicError(400, "x").error.type, "invalid_request_error");
    assert.equal(anthropicError(503, "x").error.type, "overloaded_error");
  });
  test("未知 status 退到 api_error", () => {
    assert.equal(anthropicError(418, "x").error.type, "api_error");
  });
  test("外層形狀符合 Anthropic 規格", () => {
    const e = anthropicError(500, "boom");
    assert.equal(e.type, "error");
    assert.equal(e.error.message, "boom");
  });
});

// ── Token 估算 ───────────────────────────────────────────────

describe("estimateTokens", () => {
  test("大致等於字元數 / 4 加上每則 message 的開銷", () => {
    const n = estimateTokens({ messages: [{ role: "user", content: "a".repeat(400) }] });
    assert.ok(n >= 100 && n <= 110, `got ${n}`);
  });

  test("system 也算進去", () => {
    const withSystem = estimateTokens({
      system: "b".repeat(400),
      messages: [{ role: "user", content: "hi" }],
    });
    const without = estimateTokens({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(withSystem - without >= 100);
  });

  test("工具定義也算進去", () => {
    const withTools = estimateTokens({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", description: "c".repeat(400), input_schema: { type: "object" } }],
    });
    const without = estimateTokens({ messages: [{ role: "user", content: "hi" }] });
    assert.ok(withTools - without >= 100);
  });

  test("圖片以固定值估算", () => {
    const n = estimateTokens({
      messages: [{ role: "user", content: [{ type: "image", source: { data: "x" } }] }],
    });
    assert.ok(n >= 1500, `got ${n}`);
  });

  test("空請求回 0 附近", () => {
    assert.ok(estimateTokens({ messages: [] }) <= 4);
  });
});

// ── 串流狀態機 ───────────────────────────────────────────────

describe("AnthropicStreamTranslator — 文字", () => {
  test("完整事件序列與順序", () => {
    const t = new AnthropicStreamTranslator({ model: "claude-sonnet-4-5-20250929", inputTokens: 10 });
    let out = t.start();
    out += t.feed(textChunk("Hello"));
    out += t.feed(textChunk(" world", "stop"));
    out += t.feed("data: [DONE]\n\n");
    out += t.end();

    const events = parseSSE(out).map((e) => e.event);
    assert.deepEqual(events, [
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
  });

  test("message_start 帶 model 與估算的 input_tokens", () => {
    const t = new AnthropicStreamTranslator({ model: "claude-opus-4-5-20251101", inputTokens: 42 });
    const ev = parseSSE(t.start())[0];
    assert.equal(ev.data.message.model, "claude-opus-4-5-20251101");
    assert.equal(ev.data.message.usage.input_tokens, 42);
    assert.equal(ev.data.message.stop_reason, null);
    assert.deepEqual(ev.data.message.content, []);
  });

  test("text_delta 內容正確且 index 都是 0", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(textChunk("abc")) + t.feed(textChunk("def"));
    const deltas = parseSSE(out).filter((e) => e.event === "content_block_delta");
    assert.deepEqual(deltas.map((d) => d.data.delta.text), ["abc", "def"]);
    assert.ok(deltas.every((d) => d.data.index === 0));
    assert.ok(deltas.every((d) => d.data.delta.type === "text_delta"));
  });

  test("stop_reason 由 finish_reason 決定", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    t.feed(textChunk("x", "length"));
    const ev = parseSSE(t.end()).find((e) => e.event === "message_delta");
    assert.equal(ev.data.delta.stop_reason, "max_tokens");
  });

  test("空回應仍然吐出一組完整的空 text block", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    let out = t.start();
    out += t.feed("data: [DONE]\n\n");
    out += t.end();
    const events = parseSSE(out);
    const starts = events.filter((e) => e.event === "content_block_start");
    const stops = events.filter((e) => e.event === "content_block_stop");
    assert.equal(starts.length, 1);
    assert.equal(stops.length, 1);
    assert.equal(starts[0].data.content_block.type, "text");
  });

  test("上游 usage 覆蓋估算值", () => {
    const t = new AnthropicStreamTranslator({ model: "m", inputTokens: 999 });
    t.start();
    t.feed(textChunk("hi", "stop"));
    t.feed(chunk({ choices: [], usage: { prompt_tokens: 55, completion_tokens: 7 } }));
    const ev = parseSSE(t.end()).find((e) => e.event === "message_delta");
    assert.deepEqual(ev.data.usage, { input_tokens: 55, output_tokens: 7 });
  });

  test("上游沒給 usage 時自行估算 output_tokens", () => {
    const t = new AnthropicStreamTranslator({ model: "m", inputTokens: 10 });
    t.start();
    t.feed(textChunk("a".repeat(40), "stop"));
    const ev = parseSSE(t.end()).find((e) => e.event === "message_delta");
    assert.equal(ev.data.usage.output_tokens, 10);
  });
});

describe("AnthropicStreamTranslator — SSE 解析韌性", () => {
  test("封包切在 JSON 中間也要正確重組", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const full = textChunk("hello");
    const mid = Math.floor(full.length / 2);

    let out = t.feed(full.slice(0, mid));
    // 前半段還不是完整的一行，不該吐出任何 delta
    assert.equal(parseSSE(out).length, 0);

    out += t.feed(full.slice(mid));
    const deltas = parseSSE(out).filter((e) => e.event === "content_block_delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].data.delta.text, "hello");
  });

  test("一個封包切成很多段（逐字元）結果不變", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const payload = textChunk("streamed") + textChunk("!", "stop");
    let out = "";
    for (const ch of payload) out += t.feed(ch);
    const texts = parseSSE(out)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text);
    assert.deepEqual(texts, ["streamed", "!"]);
  });

  test("多個 chunk 擠在同一個封包裡", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(textChunk("a") + textChunk("b") + textChunk("c", "stop"));
    const texts = parseSSE(out)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.text);
    assert.deepEqual(texts, ["a", "b", "c"]);
  });

  test("CRLF 換行也要處理", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(`data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\n`);
    const deltas = parseSSE(out).filter((e) => e.event === "content_block_delta");
    assert.equal(deltas[0].data.delta.text, "crlf");
  });

  test("SSE 註解與 event: 行被忽略", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(`: keep-alive\nevent: chunk\n${textChunk("ok")}`);
    const deltas = parseSSE(out).filter((e) => e.event === "content_block_delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].data.delta.text, "ok");
  });

  test("壞掉的 JSON 被跳過，串流繼續", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(`data: {broken\n\n` + textChunk("survived", "stop"));
    const deltas = parseSSE(out).filter((e) => e.event === "content_block_delta");
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].data.delta.text, "survived");
  });

  test("[DONE] 之後 end() 仍產生合法收尾", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    t.feed(textChunk("x", "stop") + "data: [DONE]\n\n");
    const events = parseSSE(t.end()).map((e) => e.event);
    assert.deepEqual(events, ["content_block_stop", "message_delta", "message_stop"]);
  });

  test("end() 呼叫兩次不會重複吐事件", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    t.feed(textChunk("x", "stop"));
    const first = t.end();
    const second = t.end();
    assert.ok(first.length > 0);
    assert.equal(second, "");
  });

  test("沒呼叫 start() 就 end() 也會補上 message_start", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    const events = parseSSE(t.end()).map((e) => e.event);
    assert.equal(events[0], "message_start");
    assert.equal(events.at(-1), "message_stop");
  });

  test("start() 呼叫兩次只送一次", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    const a = t.start();
    const b = t.start();
    assert.ok(a.includes("message_start"));
    assert.equal(b, "");
  });
});

describe("AnthropicStreamTranslator — 工具呼叫", () => {
  test("純工具呼叫：block index 從 0 開始", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    let out = t.start();
    out += t.feed(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: "" } },
              ],
            },
          },
        ],
      })
    );
    out += t.feed(
      chunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }],
      })
    );
    out += t.feed(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    out += t.end();

    const events = parseSSE(out);
    const start = events.find((e) => e.event === "content_block_start");
    assert.equal(start.data.index, 0);
    assert.equal(start.data.content_block.type, "tool_use");
    assert.equal(start.data.content_block.id, "call_1");
    assert.equal(start.data.content_block.name, "Read");
    assert.deepEqual(start.data.content_block.input, {});

    const delta = events.find((e) => e.event === "content_block_delta");
    assert.equal(delta.data.delta.type, "input_json_delta");
    assert.equal(delta.data.delta.partial_json, '{"path":"a"}');

    const msgDelta = events.find((e) => e.event === "message_delta");
    assert.equal(msgDelta.data.delta.stop_reason, "tool_use");
  });

  test("文字後面接工具呼叫：text block 先收掉，tool block 用 index 1", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    let out = t.start();
    out += t.feed(textChunk("I'll read that. "));
    out += t.feed(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"p":1}' } }],
            },
          },
        ],
      })
    );
    out += t.feed(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    out += t.end();

    const events = parseSSE(out).map((e) => ({
      event: e.event,
      index: e.data?.index,
      type: e.data?.content_block?.type,
    }));

    assert.deepEqual(events, [
      { event: "message_start", index: undefined, type: undefined },
      { event: "ping", index: undefined, type: undefined },
      { event: "content_block_start", index: 0, type: "text" },
      { event: "content_block_delta", index: 0, type: undefined },
      { event: "content_block_stop", index: 0, type: undefined },
      { event: "content_block_start", index: 1, type: "tool_use" },
      { event: "content_block_delta", index: 1, type: undefined },
      { event: "content_block_stop", index: 1, type: undefined },
      { event: "message_delta", index: undefined, type: undefined },
      { event: "message_stop", index: undefined, type: undefined },
    ]);
  });

  test("並行工具呼叫：index 依序遞增且每個都有配對的 stop", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    let out = t.start();
    out += t.feed(
      chunk({
        choices: [
          { delta: { tool_calls: [{ index: 0, id: "c0", function: { name: "A", arguments: "{}" } }] } },
        ],
      })
    );
    out += t.feed(
      chunk({
        choices: [
          { delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "B", arguments: "{}" } }] } },
        ],
      })
    );
    out += t.feed(chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    out += t.end();

    const events = parseSSE(out);
    const starts = events.filter((e) => e.event === "content_block_start");
    const stops = events.filter((e) => e.event === "content_block_stop");

    assert.deepEqual(starts.map((s) => s.data.index), [0, 1]);
    assert.deepEqual(starts.map((s) => s.data.content_block.name), ["A", "B"]);
    // 每個 start 都要有對應的 stop，否則 Claude Code 會卡住
    assert.deepEqual(stops.map((s) => s.data.index), [0, 1]);
  });

  test("name 晚一個 chunk 才到也要接得上", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    // 第一個 chunk 只有 id，沒有 name，且沒有 arguments → 還不該開 block
    let out = t.feed(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c9" }] } }] }));
    out += t.feed(
      chunk({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "Late", arguments: "{}" } }] } }],
      })
    );
    const start = parseSSE(out).find((e) => e.event === "content_block_start");
    assert.equal(start.data.content_block.id, "c9");
    assert.equal(start.data.content_block.name, "Late");
  });

  test("上游沒給 id 時自動產生 toolu_ 前綴的 id", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "X", arguments: "{}" } }] } }] })
    );
    const start = parseSSE(out).find((e) => e.event === "content_block_start");
    assert.match(start.data.content_block.id, /^toolu_/);
  });

  test("arguments 分成多段送出時逐段轉成 input_json_delta", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    let out = t.feed(
      chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "F", arguments: "" } }] } }] })
    );
    for (const frag of ['{"a"', ":1", ',"b"', ":2}"]) {
      out += t.feed(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] } }] }));
    }
    const partials = parseSSE(out)
      .filter((e) => e.event === "content_block_delta")
      .map((e) => e.data.delta.partial_json);
    assert.deepEqual(partials, ['{"a"', ":1", ',"b"', ":2}"]);
    // 拼回來要是合法 JSON
    assert.deepEqual(JSON.parse(partials.join("")), { a: 1, b: 2 });
  });

  test("tool_calls 缺 index 時退回用陣列位置", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    const out = t.feed(
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                { id: "a", function: { name: "A", arguments: "{}" } },
                { id: "b", function: { name: "B", arguments: "{}" } },
              ],
            },
          },
        ],
      })
    );
    const starts = parseSSE(out).filter((e) => e.event === "content_block_start");
    assert.deepEqual(starts.map((s) => s.data.index), [0, 1]);
  });
});

describe("AnthropicStreamTranslator — 中斷處理", () => {
  test("abort 會關掉開著的 block 再送 error", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    let out = t.start();
    out += t.feed(textChunk("partial"));
    out += t.abort("upstream exploded");

    const events = parseSSE(out);
    const names = events.map((e) => e.event);
    // content_block_stop 一定要在 error 之前，否則 UI 會一直轉圈
    assert.ok(names.indexOf("content_block_stop") < names.indexOf("error"));
    const err = events.find((e) => e.event === "error");
    assert.equal(err.data.error.message, "upstream exploded");
    assert.equal(err.data.type, "error");
  });

  test("abort 之後 end() 不再吐東西", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    t.start();
    t.feed(textChunk("x"));
    t.abort("boom");
    assert.equal(t.end(), "");
  });

  test("還沒開任何 block 就 abort 也是合法輸出", () => {
    const t = new AnthropicStreamTranslator({ model: "m" });
    const out = t.abort("early failure");
    const names = parseSSE(out).map((e) => e.event);
    assert.equal(names[0], "message_start");
    assert.ok(names.includes("error"));
  });
});

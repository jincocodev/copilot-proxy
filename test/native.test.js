// 原生 passthrough 的請求整備 — 純函式，不碰網路
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  supportsNativeMessages,
  supportedEfforts,
  supportsAdaptiveThinking,
  clampEffort,
  budgetToEffort,
  prepareNativeBody,
  stripCopilotFields,
} from "../anthropic-native.js";

// 照真上游的形狀
function model(id, { endpoints = ["/v1/messages", "/chat/completions"], efforts, adaptive } = {}) {
  const supports = { tool_calls: true, streaming: true };
  if (adaptive) {
    supports.adaptive_thinking = true;
    supports.min_thinking_budget = 1024;
    supports.max_thinking_budget = 32000;
  }
  if (efforts) supports.reasoning_effort = efforts;
  return { id, supported_endpoints: endpoints, capabilities: { supports } };
}

const FULL = model("claude-sonnet-5", {
  adaptive: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
});
// 真上游的 opus-4.6 就是這個階梯（沒有 xhigh）
const NO_XHIGH = model("claude-opus-4.6", {
  adaptive: true,
  efforts: ["low", "medium", "high", "max"],
});
const PLAIN = model("claude-sonnet-4.5");
const OPENAI_ONLY = model("gpt-4o", { endpoints: ["/chat/completions"] });

const BASE = { model: "x", max_tokens: 100, messages: [{ role: "user", content: "hi" }] };

describe("supportsNativeMessages", () => {
  test("supported_endpoints 含 /v1/messages 才算", () => {
    assert.equal(supportsNativeMessages(FULL), true);
    assert.equal(supportsNativeMessages(PLAIN), true);
    assert.equal(supportsNativeMessages(OPENAI_ONLY), false);
  });

  test("拿不到模型資訊時回 false（退回轉譯層）", () => {
    assert.equal(supportsNativeMessages(null), false);
    assert.equal(supportsNativeMessages({}), false);
  });

  test("/responses 之類的端點不算", () => {
    assert.equal(supportsNativeMessages(model("gpt-5.5", { endpoints: ["/responses"] })), false);
  });
});

describe("能力查詢", () => {
  test("supportedEfforts", () => {
    assert.deepEqual(supportedEfforts(FULL), ["low", "medium", "high", "xhigh", "max"]);
    assert.equal(supportedEfforts(PLAIN), null);
    assert.equal(supportedEfforts(null), null);
  });

  test("supportsAdaptiveThinking", () => {
    assert.equal(supportsAdaptiveThinking(FULL), true);
    assert.equal(supportsAdaptiveThinking(PLAIN), false);
    assert.equal(supportsAdaptiveThinking(null), false);
  });
});

describe("clampEffort", () => {
  const full = ["low", "medium", "high", "xhigh", "max"];

  test("支援就照用", () => {
    assert.equal(clampEffort("high", full), "high");
  });

  test("不支援時優先往下降，寧可少想也不要 400", () => {
    assert.equal(clampEffort("xhigh", ["low", "medium", "high", "max"]), "high");
  });

  test("往下沒有時才往上", () => {
    assert.equal(clampEffort("low", ["high", "max"]), "high");
  });

  test("清單為空回 null", () => {
    assert.equal(clampEffort("high", null), null);
    assert.equal(clampEffort("high", []), null);
  });

  test("不認識的檔位回 null", () => {
    assert.equal(clampEffort("turbo", full), null);
  });
});

describe("budgetToEffort", () => {
  test("按佔上限的比例分檔", () => {
    assert.equal(budgetToEffort(1000, FULL), "low"); // 3%
    assert.equal(budgetToEffort(5000, FULL), "medium"); // 16%
    assert.equal(budgetToEffort(10000, FULL), "high"); // 31%
    assert.equal(budgetToEffort(20000, FULL), "xhigh"); // 63%
    assert.equal(budgetToEffort(30000, FULL), "max"); // 94%
  });

  test("超過上限也還是 max", () => {
    assert.equal(budgetToEffort(999999, FULL), "max");
  });

  test("0 或負數回 low", () => {
    assert.equal(budgetToEffort(0, FULL), "low");
    assert.equal(budgetToEffort(-1, FULL), "low");
    assert.equal(budgetToEffort(undefined, FULL), "low");
  });
});

describe("prepareNativeBody — model 改寫", () => {
  test("只改 model，其他欄位原封不動", () => {
    const original = {
      ...BASE,
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      temperature: 0.3,
      metadata: { user_id: "u" },
    };
    const { body } = prepareNativeBody(original, "claude-sonnet-5", FULL);
    assert.equal(body.model, "claude-sonnet-5");
    assert.deepEqual(body.system, original.system);
    assert.deepEqual(body.tools, original.tools);
    assert.equal(body.temperature, 0.3);
    assert.deepEqual(body.metadata, { user_id: "u" });
  });

  test("不會改動傳入的物件", () => {
    const original = { ...BASE, thinking: { type: "enabled", budget_tokens: 4000 } };
    prepareNativeBody(original, "claude-sonnet-5", FULL);
    assert.deepEqual(original.thinking, { type: "enabled", budget_tokens: 4000 });
  });
});

describe("prepareNativeBody — thinking 形狀轉換", () => {
  test("enabled → adaptive + effort（上游不吃 enabled）", () => {
    const { body, notes } = prepareNativeBody(
      { ...BASE, thinking: { type: "enabled", budget_tokens: 10000 } },
      "claude-sonnet-5",
      FULL
    );
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.output_config.effort, "high");
    assert.ok(notes.some((n) => n.includes("adaptive")));
  });

  test("client 已經給 effort 時不用 budget 蓋掉它", () => {
    const { body } = prepareNativeBody(
      {
        ...BASE,
        thinking: { type: "enabled", budget_tokens: 30000 },
        output_config: { effort: "low" },
      },
      "claude-sonnet-5",
      FULL
    );
    assert.equal(body.output_config.effort, "low");
  });

  test("adaptive 原樣保留", () => {
    const { body } = prepareNativeBody(
      { ...BASE, thinking: { type: "adaptive" }, output_config: { effort: "max" } },
      "claude-sonnet-5",
      FULL
    );
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.output_config.effort, "max");
  });

  test("disabled 直接剝掉", () => {
    const { body } = prepareNativeBody(
      { ...BASE, thinking: { type: "disabled" } },
      "claude-sonnet-5",
      FULL
    );
    assert.equal(body.thinking, undefined);
  });

  test("模型不支援 thinking 時剝掉並記一筆", () => {
    const { body, notes } = prepareNativeBody(
      { ...BASE, thinking: { type: "enabled", budget_tokens: 4000 } },
      "claude-sonnet-4.5",
      PLAIN
    );
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
    assert.ok(notes.some((n) => n.includes("不支援 thinking")));
  });

  test("模型不支援時連 adaptive 也剝掉", () => {
    const { body } = prepareNativeBody(
      { ...BASE, thinking: { type: "adaptive" } },
      "claude-haiku-4.5",
      PLAIN
    );
    assert.equal(body.thinking, undefined);
  });
});

describe("prepareNativeBody — effort 收斂", () => {
  test("階梯缺 xhigh 時降到 high", () => {
    const { body, notes } = prepareNativeBody(
      { ...BASE, output_config: { effort: "xhigh" } },
      "claude-opus-4.6",
      NO_XHIGH
    );
    assert.equal(body.output_config.effort, "high");
    assert.ok(notes.some((n) => n.includes("xhigh")));
  });

  test("給 effort 但沒給 thinking 時自動補 adaptive（否則 effort 不生效）", () => {
    const { body } = prepareNativeBody(
      { ...BASE, output_config: { effort: "high" } },
      "claude-sonnet-5",
      FULL
    );
    assert.deepEqual(body.thinking, { type: "adaptive" });
  });

  test("完全不支援 effort 時剝掉，避免上游 400", () => {
    const { body, notes } = prepareNativeBody(
      { ...BASE, output_config: { effort: "high" } },
      "claude-sonnet-4.5",
      PLAIN
    );
    assert.equal(body.output_config, undefined);
    assert.equal(body.thinking, undefined);
    assert.ok(notes.some((n) => n.includes("reasoning effort")));
  });

  test("剝 effort 時保留 output_config 的其他欄位", () => {
    const { body } = prepareNativeBody(
      { ...BASE, output_config: { effort: "high", verbosity: "low" } },
      "claude-sonnet-4.5",
      PLAIN
    );
    assert.deepEqual(body.output_config, { verbosity: "low" });
  });

  test("沒要求思考時什麼都不加", () => {
    const { body, notes } = prepareNativeBody({ ...BASE }, "claude-sonnet-5", FULL);
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
    assert.deepEqual(notes, []);
  });

  test("拿不到模型資訊時保守剝掉 thinking 相關參數", () => {
    const { body } = prepareNativeBody(
      { ...BASE, thinking: { type: "enabled", budget_tokens: 4000 }, output_config: { effort: "high" } },
      "claude-sonnet-5",
      null
    );
    assert.equal(body.thinking, undefined);
    assert.equal(body.output_config, undefined);
  });
});

describe("stripCopilotFields", () => {
  test("剝掉 copilot_usage 並取出成本", () => {
    const { json, costNanoAiu } = stripCopilotFields({
      type: "message",
      usage: { input_tokens: 5 },
      copilot_usage: { total_nano_aiu: 6000000 },
    });
    assert.equal(json.copilot_usage, undefined);
    assert.equal(json.type, "message");
    assert.deepEqual(json.usage, { input_tokens: 5 });
    assert.equal(costNanoAiu, 6000000);
  });

  test("沒有這個欄位時原樣回傳", () => {
    const input = { type: "message" };
    const { json, costNanoAiu } = stripCopilotFields(input);
    assert.equal(json, input);
    assert.equal(costNanoAiu, null);
  });

  test("非物件不會爆掉", () => {
    assert.equal(stripCopilotFields(null).json, null);
  });
});

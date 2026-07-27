// OpenAI SSE chunk → Anthropic Messages SSE 事件序列
//
// 這是整個 proxy 最容易出錯的地方。Claude Code 對事件配對很敏感：
// 少一個 content_block_stop 就會卡住不顯示，block index 跳號則會錯位。
// 所以這裡用明確的狀態機，一次只開一個 content block。
//
// Anthropic 事件順序（單一文字回應）：
//   message_start → ping → content_block_start(0) → content_block_delta(0)*
//   → content_block_stop(0) → message_delta → message_stop
//
// 文字後面接工具呼叫時，index 要遞增：
//   ...content_block_stop(0) → content_block_start(1, tool_use)
//   → content_block_delta(1, input_json_delta)* → content_block_stop(1) → ...

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function randomId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
}

const STOP_REASON_MAP = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

class AnthropicStreamTranslator {
  constructor({ model, inputTokens = 0 } = {}) {
    this.model = model;
    this.inputTokens = inputTokens;
    this.messageId = randomId("msg");

    // SSE 解析用的暫存 — 上游封包可能切在 JSON 中間
    this.buffer = "";
    this.upstreamDone = false;

    // content block 狀態：一次只開一個
    this.nextIndex = 0;
    this.openBlock = null; // { kind: 'text' | 'tool', index, key }
    this.anyBlockOpened = false;

    // OpenAI tool_call index → { anthropicIndex, id, name, closed }
    this.toolBlocks = new Map();

    this.finishReason = null;
    this.sawToolUse = false;
    this.outputTokens = 0;
    this.usageFromUpstream = null;

    this.started = false;
    this.ended = false;
  }

  // message_start（+ 一個 ping，讓連線立刻有東西流出去）
  start() {
    if (this.started) return "";
    this.started = true;
    return (
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.messageId,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }) + sse("ping", { type: "ping" })
    );
  }

  // 餵入上游的原始 SSE 文字，回傳要寫給 client 的 Anthropic 事件
  feed(text) {
    this.buffer += text;
    let out = "";

    // 只處理完整的行，剩下的留在 buffer 裡等下一個封包
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "").trim();
      if (line === "") continue;
      if (line.startsWith(":")) continue; // SSE 註解／keep-alive
      if (!line.startsWith("data:")) continue; // event: / id: 一律忽略

      const payload = line.slice(5).trim();
      if (payload === "") continue;
      if (payload === "[DONE]") {
        this.upstreamDone = true;
        continue;
      }

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        // 上游偶爾會送出壞掉的 JSON，跳過比整條串流掛掉好
        continue;
      }
      out += this.processChunk(chunk);
    }

    return out;
  }

  processChunk(chunk) {
    let out = "";

    if (chunk.usage) {
      this.usageFromUpstream = chunk.usage;
      if (typeof chunk.usage.completion_tokens === "number") {
        this.outputTokens = chunk.usage.completion_tokens;
      }
      if (typeof chunk.usage.prompt_tokens === "number") {
        this.inputTokens = chunk.usage.prompt_tokens;
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) return out;

    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta || {};

    // ── 文字 ──
    if (typeof delta.content === "string" && delta.content.length > 0) {
      out += this.ensureTextBlock();
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.openBlock.index,
        delta: { type: "text_delta", text: delta.content },
      });
      // 上游沒給 usage 時自己估
      if (!this.usageFromUpstream) {
        this.outputTokens += Math.ceil(delta.content.length / 4);
      }
    }

    // 某些上游把推理內容放在 reasoning_content，Copilot 目前不會，但先接住
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      // extended thinking 無法對應，直接丟棄不污染輸出
    }

    // ── 工具呼叫 ──
    if (Array.isArray(delta.tool_calls)) {
      for (let i = 0; i < delta.tool_calls.length; i++) {
        const call = delta.tool_calls[i];
        if (!call) continue;
        const key = typeof call.index === "number" ? call.index : i;
        out += this.handleToolCallDelta(key, call);
      }
    }

    return out;
  }

  handleToolCallDelta(key, call) {
    let out = "";
    let entry = this.toolBlocks.get(key);

    if (!entry) {
      entry = {
        anthropicIndex: null,
        id: call.id || randomId("toolu"),
        name: call.function?.name || "",
        closed: false,
        started: false,
      };
      this.toolBlocks.set(key, entry);
    }

    // id / name 可能晚一個 chunk 才到，但只有在 block 還沒開始前補得進去
    if (!entry.started) {
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
    }

    if (entry.closed) {
      // 已經關掉的 block 不能重開，只能丟棄（實務上不會發生）
      return out;
    }

    const args = call.function?.arguments;

    // 上游常常先送一個只有 id 的 chunk，name 晚一拍才到。
    // content_block_start 一旦送出就不能改 name，所以要等 name 到齊才開 block。
    if (!entry.started && !entry.name && !(typeof args === "string" && args.length > 0)) {
      return out;
    }

    // 換 block：先把目前開著的關掉
    if (!this.openBlock || this.openBlock.kind !== "tool" || this.openBlock.key !== key) {
      out += this.closeOpenBlock();
      entry.anthropicIndex = this.nextIndex++;
      entry.started = true;
      this.sawToolUse = true;
      this.anyBlockOpened = true;
      this.openBlock = { kind: "tool", index: entry.anthropicIndex, key };
      out += sse("content_block_start", {
        type: "content_block_start",
        index: entry.anthropicIndex,
        content_block: { type: "tool_use", id: entry.id, name: entry.name, input: {} },
      });
    }

    if (typeof args === "string" && args.length > 0) {
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: entry.anthropicIndex,
        delta: { type: "input_json_delta", partial_json: args },
      });
      if (!this.usageFromUpstream) {
        this.outputTokens += Math.ceil(args.length / 4);
      }
    }

    return out;
  }

  ensureTextBlock() {
    if (this.openBlock?.kind === "text") return "";
    let out = this.closeOpenBlock();
    const index = this.nextIndex++;
    this.openBlock = { kind: "text", index, key: null };
    this.anyBlockOpened = true;
    out += sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return out;
  }

  closeOpenBlock() {
    if (!this.openBlock) return "";
    const { index, kind, key } = this.openBlock;
    if (kind === "tool") {
      const entry = this.toolBlocks.get(key);
      if (entry) entry.closed = true;
    }
    this.openBlock = null;
    return sse("content_block_stop", { type: "content_block_stop", index });
  }

  // 收尾：關掉所有開著的 block，補 message_delta / message_stop
  end() {
    if (this.ended) return "";
    this.ended = true;

    let out = "";
    if (!this.started) out += this.start();
    out += this.closeOpenBlock();

    // Anthropic 規定至少要有一個 content block
    if (!this.anyBlockOpened) {
      out += sse("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      out += sse("content_block_stop", { type: "content_block_stop", index: 0 });
    }

    const stopReason = this.sawToolUse
      ? "tool_use"
      : STOP_REASON_MAP[this.finishReason] || "end_turn";

    out += sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    });
    out += sse("message_stop", { type: "message_stop" });

    return out;
  }

  // 上游中途爆掉：關掉開著的 block，送 error 事件，然後正常收尾
  // （少了 content_block_stop，Claude Code 的 UI 會一直轉圈）
  abort(message, errorType = "api_error") {
    if (this.ended) return "";
    let out = "";
    if (!this.started) out += this.start();
    out += this.closeOpenBlock();
    out += sse("error", {
      type: "error",
      error: { type: errorType, message: message || "Upstream stream failed" },
    });
    this.ended = true;
    return out;
  }
}

export { AnthropicStreamTranslator, sse };

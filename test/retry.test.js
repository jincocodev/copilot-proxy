// 上游連線失敗的診斷與重試 — 純函式與注入的 fetch，不碰網路
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.PROXY_API_KEY = "test-key-123";
process.env.COPILOT_THINKING_EFFORT = "";
process.env.COPILOT_DEFAULT_MODEL = "";

const { describeError, isTransientNetworkError, fetchWithRetry } = await import("../proxy.js");

// undici 連線失敗的形狀：TypeError: fetch failed，真正原因在 cause
function undiciError(code) {
  const err = new TypeError("fetch failed");
  err.cause = Object.assign(new Error("read ECONNRESET"), { code, errno: -54, syscall: "read" });
  return err;
}

describe("describeError", () => {
  test("展開 err.cause，不只印 fetch failed", () => {
    const out = describeError(undiciError("ECONNRESET"));
    assert.match(out, /fetch failed/);
    assert.match(out, /ECONNRESET/);
    assert.match(out, /syscall=|read/);
  });

  test("沒有 cause 時只印 message", () => {
    assert.equal(describeError(new Error("boom")), "boom");
  });

  test("非 Error 也不會爆掉", () => {
    assert.equal(typeof describeError("just a string"), "string");
    assert.equal(typeof describeError(null), "string");
  });
});

describe("isTransientNetworkError", () => {
  test("連線層錯誤算暫時性", () => {
    for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"]) {
      assert.equal(isTransientNetworkError(undiciError(code)), true, code);
    }
  });

  test("沒有 code 的 fetch failed 也算（undici 有時不給 code）", () => {
    assert.equal(isTransientNetworkError(new TypeError("fetch failed")), true);
  });

  test("語意錯誤不算 —— 重試只會再錯一次", () => {
    assert.equal(isTransientNetworkError(new Error("Upstream /models failed: HTTP 400")), false);
    assert.equal(isTransientNetworkError(new Error("Not authorized")), false);
  });

  test("非暫時性的 code 不算", () => {
    assert.equal(isTransientNetworkError(undiciError("ENOTFOUND")), false);
  });
});

describe("fetchWithRetry", () => {
  test("第一次就成功時只呼叫一次", async () => {
    let calls = 0;
    const res = await fetchWithRetry(async () => {
      calls++;
      return "ok";
    }, { label: "t" });
    assert.equal(res, "ok");
    assert.equal(calls, 1);
  });

  test("暫時性失敗後重試成功", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls++;
        if (calls === 1) throw undiciError("ECONNRESET");
        return "recovered";
      },
      { label: "t" }
    );
    assert.equal(res, "recovered");
    assert.equal(calls, 2);
  });

  test("超過次數就往外丟", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchWithRetry(
          async () => {
            calls++;
            throw undiciError("ECONNRESET");
          },
          { label: "t" }
        ),
      /fetch failed/
    );
    assert.equal(calls, 2, "預設兩次");
  });

  test("非暫時性錯誤不重試，立刻往外丟", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        fetchWithRetry(
          async () => {
            calls++;
            throw new Error("HTTP 400 invalid model");
          },
          { label: "t" }
        ),
      /invalid model/
    );
    assert.equal(calls, 1, "不該重試");
  });

  test("attempts 可以調高", async () => {
    let calls = 0;
    await assert.rejects(() =>
      fetchWithRetry(
        async () => {
          calls++;
          throw undiciError("ECONNRESET");
        },
        { label: "t", attempts: 3 }
      )
    );
    assert.equal(calls, 3);
  });
});

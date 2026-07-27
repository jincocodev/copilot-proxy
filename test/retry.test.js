// 上游連線失敗的診斷與重試 — 純函式與注入的 fetch，不碰網路
import { test, describe } from "node:test";
import assert from "node:assert/strict";

process.env.PROXY_API_KEY = "test-key-123";
process.env.COPILOT_THINKING_EFFORT = "";
process.env.COPILOT_DEFAULT_MODEL = "";

const { describeError, isTransientNetworkError, isRetryableForIdempotent, fetchWithRetry } =
  await import("../proxy.js");

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

describe("isTransientNetworkError — POST 用，嚴格", () => {
  // Copilot 按請求計費。連線建立後才斷的錯誤，請求可能已經送達並被處理，
  // 重試就是付兩次錢，所以只有「確定沒送出去」才重試。
  test("連線根本沒建立起來 → 可以重試", () => {
    for (const code of ["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
      assert.equal(isTransientNetworkError(undiciError(code)), true, code);
    }
  });

  test("連線建立後才斷 → 不重試（可能已被上游處理，會重複計費）", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT"]) {
      assert.equal(isTransientNetworkError(undiciError(code)), false, code);
    }
  });

  test("沒有 code 的 fetch failed → 情況不明，不重試", () => {
    assert.equal(isTransientNetworkError(new TypeError("fetch failed")), false);
  });

  test("語意錯誤不算 —— 重試只會再錯一次", () => {
    assert.equal(isTransientNetworkError(new Error("Upstream /models failed: HTTP 400")), false);
    assert.equal(isTransientNetworkError(new Error("Not authorized")), false);
  });

  test("非網路的 code 不算", () => {
    assert.equal(isTransientNetworkError(undiciError("ENOTFOUND")), false);
  });
});

describe("isRetryableForIdempotent — GET 用，放寬", () => {
  test("GET 重送沒副作用，連線建立後才斷的也重試", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]) {
      assert.equal(isRetryableForIdempotent(undiciError(code)), true, code);
    }
  });

  test("沒有 code 的 fetch failed 也重試", () => {
    assert.equal(isRetryableForIdempotent(new TypeError("fetch failed")), true);
  });

  test("語意錯誤仍然不重試", () => {
    assert.equal(isRetryableForIdempotent(new Error("HTTP 400")), false);
    assert.equal(isRetryableForIdempotent(undiciError("ENOTFOUND")), false);
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
        if (calls === 1) throw undiciError("ECONNREFUSED");
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
            throw undiciError("ECONNREFUSED");
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
          throw undiciError("ECONNREFUSED");
        },
        { label: "t", attempts: 3 }
      )
    );
    assert.equal(calls, 3);
  });
});

describe("fetchWithRetry — idempotent 旗標", () => {
  test("POST（預設）遇到 ECONNRESET 不重試", async () => {
    let calls = 0;
    await assert.rejects(() =>
      fetchWithRetry(
        async () => {
          calls++;
          throw undiciError("ECONNRESET");
        },
        { label: "post" }
      )
    );
    assert.equal(calls, 1, "POST 不該重試已可能送達的請求");
  });

  test("idempotent:true 遇到 ECONNRESET 會重試", async () => {
    let calls = 0;
    const res = await fetchWithRetry(
      async () => {
        calls++;
        if (calls < 2) throw undiciError("ECONNRESET");
        return "ok";
      },
      { label: "get", idempotent: true }
    );
    assert.equal(res, "ok");
    assert.equal(calls, 2);
  });
});

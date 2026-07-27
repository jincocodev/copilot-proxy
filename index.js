import { config } from "dotenv";
config();

import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import {
  init,
  isAuthorized,
  startDeviceFlow,
  getStatus,
} from "./token-manager.js";
import { proxyRequest, anthropicRequest } from "./proxy.js";
import { estimateTokens, mapModel } from "./anthropic-adapter.js";

const app = express();
const PORT = process.env.PORT || 3456;
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
const VERSION = "1.1.0";

// ── CORS ──
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    // 後四個是 Anthropic SDK / Claude Code 會送的
    "Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

let stats = {
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsFailed: 0,
  startedAt: new Date().toISOString(),
};

// --- Middleware ---

app.use(express.json({ limit: "10mb" }));

// API key auth for /v1/* endpoints
function apiKeyAuth(req, res, next) {
  if (!PROXY_API_KEY) return next(); // no key set = open
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${PROXY_API_KEY}`) {
    return res.status(401).json({ error: { message: "Invalid API key" } });
  }
  next();
}

// Anthropic 端點專用：Claude Code 設 ANTHROPIC_API_KEY 時只會送 x-api-key，
// 設 ANTHROPIC_AUTH_TOKEN 時才送 Authorization: Bearer。兩種都要收。
// 注意：這只套用在 /v1/messages*，/v1/chat/completions 仍然只吃 Authorization。
function anthropicApiKeyAuth(req, res, next) {
  if (!PROXY_API_KEY) return next(); // no key set = open

  const xApiKey = req.headers["x-api-key"];
  const auth = req.headers.authorization;

  const ok =
    xApiKey === PROXY_API_KEY ||
    auth === `Bearer ${PROXY_API_KEY}` ||
    auth === PROXY_API_KEY;

  if (!ok) {
    return res.status(401).json({
      type: "error",
      error: { type: "authentication_error", message: "Invalid API key" },
    });
  }
  next();
}

// Auth check for /v1/* endpoints
function requireAuth(req, res, next) {
  if (!isAuthorized()) {
    return res.status(503).json({
      error: {
        message: "GitHub not authorized. POST /admin/auth to start device flow.",
      },
    });
  }
  next();
}

// Anthropic 格式的上游未授權錯誤
function requireAuthAnthropic(req, res, next) {
  if (!isAuthorized()) {
    return res.status(503).json({
      type: "error",
      error: {
        type: "api_error",
        message: "GitHub not authorized. POST /admin/auth to start device flow.",
      },
    });
  }
  next();
}

// --- OpenAI-compatible endpoints ---

// 實測確認可用的模型（GitHub Copilot Business）
const MODELS = [
  // Anthropic
  { id: "claude-opus-4.6",          owned_by: "anthropic" },
  { id: "claude-opus-4.5",          owned_by: "anthropic" },
  { id: "claude-sonnet-4.5",        owned_by: "anthropic" },
  { id: "claude-sonnet-4",          owned_by: "anthropic" },
  // OpenAI
  { id: "gpt-4o",                   owned_by: "openai" },
  { id: "gpt-4o-mini",              owned_by: "openai" },
  { id: "gpt-4",                    owned_by: "openai" },
  { id: "gpt-4.1",                  owned_by: "openai" },
  // Google
  { id: "gemini-2.5-pro",           owned_by: "google" },
  { id: "gemini-3-flash-preview",   owned_by: "google" },
];

app.get("/v1/models", apiKeyAuth, requireAuth, (req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
    })),
  });
});

app.post("/v1/chat/completions", apiKeyAuth, requireAuth, async (req, res) => {
  stats.requestsTotal++;
  const { success } = await proxyRequest(req, res);
  if (success) {
    stats.requestsSuccess++;
  } else {
    stats.requestsFailed++;
  }
});

// --- Anthropic Messages endpoints (Claude Code) ---

// Copilot 沒有 count_tokens 端點，這裡是估算值。
// 要放在 /v1/messages 前面註冊，否則會被吃掉。
app.post("/v1/messages/count_tokens", anthropicApiKeyAuth, (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: "messages must be an array" },
    });
  }
  res.json({ input_tokens: estimateTokens(body) });
});

app.post("/v1/messages", anthropicApiKeyAuth, requireAuthAnthropic, async (req, res) => {
  stats.requestsTotal++;
  const { success } = await anthropicRequest(req, res);
  if (success) {
    stats.requestsSuccess++;
  } else {
    stats.requestsFailed++;
  }
});

// --- Admin endpoints ---

app.get("/admin/status", apiKeyAuth, (req, res) => {
  const tokenStatus = getStatus();
  res.json({
    proxy: {
      version: VERSION,
      uptime_seconds: Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
      started_at: stats.startedAt,
      port: PORT,
      api_key_set: !!PROXY_API_KEY,
      endpoints: {
        openai: "/v1/chat/completions",
        anthropic: "/v1/messages",
        count_tokens: "/v1/messages/count_tokens",
      },
    },
    auth: tokenStatus,
    stats: {
      requests_total: stats.requestsTotal,
      requests_success: stats.requestsSuccess,
      requests_failed: stats.requestsFailed,
    },
  });
});

app.post("/admin/auth", apiKeyAuth, async (req, res) => {
  if (isAuthorized()) {
    return res.json({ message: "Already authorized", authorized: true });
  }
  try {
    const device = await startDeviceFlow();
    res.json({
      message: "Device flow started. Open the URL and enter the code.",
      ...device,
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// 檢查 Claude Code 的 model 名稱會被對到哪個 Copilot model
app.get("/admin/model-map", apiKeyAuth, (req, res) => {
  const probe = req.query.model;
  if (probe) return res.json({ requested: probe, mapped: mapModel(probe) });
  res.json({
    examples: [
      "claude-opus-4-6-20260205",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "claude-3-5-haiku-20241022",
    ].map((m) => ({ requested: m, mapped: mapModel(m) })),
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: isAuthorized() ? "ok" : "needs_auth",
    authorized: isAuthorized(),
    version: VERSION,
  });
});

// --- Start ---

function startServer(port = PORT) {
  const hasToken = init();

  const server = app.listen(port, () => {
    console.log(`🚀 Copilot Proxy v${VERSION} 啟動於 http://localhost:${port}`);
    console.log(`   OpenAI API:    http://localhost:${port}/v1/chat/completions`);
    console.log(`   Anthropic API: http://localhost:${port}/v1/messages`);
    console.log(`   管理:          http://localhost:${port}/admin/status`);
    if (!hasToken) {
      console.log(`\n⚠️  尚未授權 GitHub，請 POST /admin/auth 開始授權`);
    }
  });

  function shutdown(signal) {
    console.log(`\n${signal} received, shutting down...`);
    server.close(() => {
      console.log("✅ Server closed");
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => process.exit(1), 10000);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

// 只有直接執行才啟動 listener，被測試 import 時不啟動
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) startServer();

export { app, startServer, VERSION };

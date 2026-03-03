import { config } from "dotenv";
config();

import express from "express";
import {
  init,
  isAuthorized,
  startDeviceFlow,
  getStatus,
} from "./token-manager.js";
import { proxyRequest } from "./proxy.js";

const app = express();
const PORT = process.env.PORT || 3456;
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";

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

// --- OpenAI-compatible endpoints ---

app.get("/v1/models", apiKeyAuth, requireAuth, (req, res) => {
  // 實測確認可用的模型（GitHub Copilot Business）
  const models = [
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
  res.json({
    object: "list",
    data: models.map((m) => ({
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

// --- Admin endpoints ---

app.get("/admin/status", apiKeyAuth, (req, res) => {
  const tokenStatus = getStatus();
  res.json({
    proxy: {
      version: "1.0.0",
      uptime_seconds: Math.round((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
      started_at: stats.startedAt,
      port: PORT,
      api_key_set: !!PROXY_API_KEY,
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

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: isAuthorized() ? "ok" : "needs_auth",
    authorized: isAuthorized(),
  });
});

// --- Start ---

const hasToken = init();

const server = app.listen(PORT, () => {
  console.log(`🚀 Copilot Proxy 啟動於 http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/v1/chat/completions`);
  console.log(`   管理: http://localhost:${PORT}/admin/status`);
  if (!hasToken) {
    console.log(`\n⚠️  尚未授權 GitHub，請 POST /admin/auth 開始授權`);
  }
});

// Graceful shutdown
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

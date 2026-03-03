import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || path.join(__dirname, ".credentials.json");

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_API_BASE = "https://api.individual.githubcopilot.com";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 min before expiry

let state = {
  accessToken: null,
  copilotToken: null,
  copilotTokenExpiresAt: 0,
  apiBaseUrl: DEFAULT_API_BASE,
  refreshPromise: null, // dedup concurrent refreshes
};

// --- Credentials persistence ---

function loadCredentials() {
  try {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    return data.accessToken || null;
  } catch {
    return null;
  }
}

function saveCredentials(accessToken) {
  fs.writeFileSync(
    CREDENTIALS_PATH,
    JSON.stringify({ accessToken, savedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
  fs.chmodSync(CREDENTIALS_PATH, 0o600);
}

// --- GitHub Device Flow ---

async function requestDeviceCode() {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`Device code request failed: HTTP ${res.status}`);
  const json = await res.json();
  if (!json.device_code || !json.user_code || !json.verification_uri)
    throw new Error("Invalid device code response");
  return json;
}

let pendingDeviceFlow = null; // track in-progress device flow

async function startDeviceFlow() {
  const device = await requestDeviceCode();
  const expiresAt = Date.now() + device.expires_in * 1000;
  const intervalMs = Math.max(1000, (device.interval || 5) * 1000);

  pendingDeviceFlow = {
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    resolved: false,
  };

  // Start polling in background
  pollForAccessToken(device.device_code, intervalMs, expiresAt);

  return {
    user_code: device.user_code,
    verification_uri: device.verification_uri,
    expires_in: device.expires_in,
  };
}

async function pollForAccessToken(deviceCode, initialIntervalMs, expiresAt) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  let intervalMs = initialIntervalMs;

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const res = await fetch(ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });
      if (!res.ok) continue;
      const json = await res.json();

      if (json.access_token) {
        state.accessToken = json.access_token;
        saveCredentials(json.access_token);
        if (pendingDeviceFlow) pendingDeviceFlow.resolved = true;
        pendingDeviceFlow = null;
        console.log("✅ GitHub 授權成功，access_token 已儲存");
        return;
      }

      const err = json.error || "unknown";
      if (err === "authorization_pending") continue;
      if (err === "slow_down") {
        intervalMs += 2000;
        continue;
      }
      if (err === "expired_token" || err === "access_denied") {
        console.error(`❌ Device flow 失敗: ${err}`);
        pendingDeviceFlow = null;
        return;
      }
    } catch (e) {
      // network error, retry
    }
  }
  console.error("❌ Device code 已過期");
  pendingDeviceFlow = null;
}

// --- Copilot Token Management ---

function deriveCopilotApiBase(token) {
  const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  if (!match) return DEFAULT_API_BASE;
  const host = match[1].replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  return host ? `https://${host}` : DEFAULT_API_BASE;
}

async function ensureCopilotToken() {
  if (!state.accessToken) throw new Error("Not authorized");

  // Token still valid
  if (state.copilotToken && state.copilotTokenExpiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return state.copilotToken;
  }

  // Dedup concurrent refresh
  if (state.refreshPromise) return state.refreshPromise;

  state.refreshPromise = (async () => {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(COPILOT_TOKEN_URL, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${state.accessToken}`,
          },
        });
        if (!res.ok) {
          if (attempt < MAX_RETRIES && res.status >= 500) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
        }
        const json = await res.json();

        if (!json.token || !json.expires_at)
          throw new Error("Invalid copilot token response");

        let expiresAtMs = typeof json.expires_at === "number" ? json.expires_at : parseInt(json.expires_at, 10);
        if (expiresAtMs < 1e12) expiresAtMs *= 1000; // seconds → ms

        state.copilotToken = json.token;
        state.copilotTokenExpiresAt = expiresAtMs;
        state.apiBaseUrl = deriveCopilotApiBase(json.token);

        return state.copilotToken;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  })().finally(() => {
    state.refreshPromise = null;
  });

  return state.refreshPromise;
}

// --- Exports ---

function isAuthorized() {
  return !!state.accessToken;
}

function getStatus() {
  const now = Date.now();
  return {
    authorized: !!state.accessToken,
    copilot_token_valid: !!(state.copilotToken && state.copilotTokenExpiresAt > now),
    copilot_token_expires_in_seconds: state.copilotToken
      ? Math.max(0, Math.round((state.copilotTokenExpiresAt - now) / 1000))
      : 0,
    api_base_url: state.apiBaseUrl,
    pending_device_flow: pendingDeviceFlow
      ? {
          user_code: pendingDeviceFlow.userCode,
          verification_uri: pendingDeviceFlow.verificationUri,
          resolved: pendingDeviceFlow.resolved,
        }
      : null,
  };
}

function init() {
  const saved = loadCredentials();
  if (saved) {
    state.accessToken = saved;
    console.log("✅ 已載入 access_token");
    return true;
  }
  return false;
}

export {
  init,
  isAuthorized,
  startDeviceFlow,
  ensureCopilotToken,
  getStatus,
  state,
};

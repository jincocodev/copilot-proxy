# Copilot Proxy

輕量 Proxy，把 GitHub Copilot 同時包成 **OpenAI 相容 API** 和 **Anthropic Messages API**，自動管理 Copilot token。

- `/v1/chat/completions` — OpenAI 相容（Dify、Xcode Intelligence、OpenAI SDK…）
- `/v1/messages` — Anthropic Messages（**Claude Code**、Anthropic SDK）

## 快速開始

### Docker（推薦）

```bash
cp .env.example .env   # 填 PROXY_API_KEY
docker compose up -d
```

### 本機

```bash
npm install
cp .env.example .env   # 填 PROXY_API_KEY
npm start
```

## 首次授權

```bash
curl -X POST http://localhost:3456/admin/auth \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# 回應會給你 user_code 和 URL
# 去 https://github.com/login/device 輸入 code
# 授權完成後自動生效
```

## 搭配 Claude Code

```bash
chmod +x claude-code.sh
./claude-code.sh
```

腳本會先檢查 proxy 健康狀態與授權，再帶著環境變數啟動 `claude`。只影響該次執行，不改全域設定。

手動設定的話：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=YOUR_PROXY_API_KEY
export ANTHROPIC_MODEL=claude-sonnet-4.5
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.6
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-sonnet-4
claude
```

### Model 名稱對照

Claude Code 會送出帶日期的完整 model id，proxy 自動對照到 Copilot 的短名：

| Claude Code 送出 | 對到 Copilot |
|---|---|
| `claude-opus-4-6-*` | `claude-opus-4.6` |
| `claude-opus-4-5-*` | `claude-opus-4.5` |
| `claude-sonnet-4-5-*` | `claude-sonnet-4.5` |
| `claude-sonnet-4-*` | `claude-sonnet-4` |
| `claude-3-5-haiku-*`、`claude-haiku-4-5-*` | `claude-sonnet-4`（Copilot 沒有 haiku） |
| 其他未知的 `claude-*` | `claude-sonnet-4.5` |

查對照結果：

```bash
curl "http://localhost:3456/admin/model-map?model=claude-sonnet-4-5-20250929" \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"
```

### Copilot 上游缺的能力

透過 Copilot 走的話，以下 Anthropic 功能拿不到：

| 功能 | 狀況 |
|---|---|
| Prompt caching | **不支援**。`cache_control` 會被忽略，長 session 的成本降不下來 |
| Extended thinking | **不支援**。`thinking` block 不會往上游送，也不會回傳 |
| Token 計數 | **估算值**。Copilot 沒有 count_tokens 端點，Claude Code 顯示的 context 用量會有誤差（約 4 char/token，圖片固定算 1500） |
| `top_k` | 忽略（OpenAI 格式沒有對應欄位） |
| tool_result 內的圖片 | 會被換成文字佔位符（OpenAI 的 tool message 不支援圖片） |
| 伺服器端工具（web_search 等） | 略過不送 |

一般的對話、檔案編輯、工具呼叫、串流、視覺輸入都可以正常用。

## API Endpoints

### Anthropic Messages（Claude Code）

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "hello"}]
  }'

# 串流
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -d '{"model":"claude-sonnet-4.5","max_tokens":1024,"stream":true,
       "messages":[{"role":"user","content":"hello"}]}'

# Token 估算（Copilot 沒有這個端點，回的是估算值）
curl http://localhost:3456/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_API_KEY" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}]}'
```

### OpenAI 相容

```bash
# 模型列表
curl http://localhost:3456/v1/models \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# Chat Completions
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -d '{"model":"claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}]}'

# Streaming
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hello"}],"stream":true}'
```

### Admin

```bash
# 狀態（uptime、授權、token TTL、請求統計）
curl http://localhost:3456/admin/status \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# 觸發授權
curl -X POST http://localhost:3456/admin/auth \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# Model 對照查詢
curl http://localhost:3456/admin/model-map \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# 健康檢查（不需 API key）
curl http://localhost:3456/health
```

## 認證方式

兩條路徑接受的 header 不一樣：

| 端點 | 接受的 header |
|---|---|
| `/v1/messages`、`/v1/messages/count_tokens` | `x-api-key: <key>` 或 `Authorization: Bearer <key>` |
| `/v1/chat/completions`、`/v1/models`、`/admin/*` | `Authorization: Bearer <key>` |

Anthropic 端點多收 `x-api-key` 是因為 Claude Code 設 `ANTHROPIC_API_KEY` 時只送這個 header。

`PROXY_API_KEY` 留空 = 完全不驗證。

## 可用模型

| Provider | Models |
|----------|--------|
| Anthropic | claude-opus-4.6, claude-opus-4.5, claude-sonnet-4.5, claude-sonnet-4 |
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4, gpt-4.1 |
| Google | gemini-2.5-pro, gemini-3-flash-preview |

## Xcode 26 Intelligence 設定

### Internet Hosted（推薦）

| 欄位 | 值 |
|------|-----|
| URL | `https://your-domain/v1` |
| API Key | `Bearer YOUR_PROXY_API_KEY`（含 Bearer 前綴） |
| API Key Header | `Authorization` |
| Description | Copilot Proxy |

> ⚠️ Xcode 的 API Key 欄位要填完整的 `Bearer <key>`，因為 Xcode 不會自動加 `Bearer` 前綴。

### Locally Hosted（免驗證）

如果 Proxy 跑在本地且 `PROXY_API_KEY` 設為空：

| 欄位 | 值 |
|------|-----|
| Port | `3456` |

## Dify 設定

1. 模型供應商 → OpenAI-API-compatible
2. API endpoint URL: `https://your-domain/v1`
3. API Key: 你的 `PROXY_API_KEY`
4. Model Name: 上表任一模型名

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3456` | 監聽 port |
| `PROXY_API_KEY` | (空) | API key，空 = 不驗證 |
| `CREDENTIALS_PATH` | `.credentials.json` | GitHub token 儲存路徑 |

## 測試

```bash
npm test
```

用本機 mock 上游跑，不需要 GitHub 憑證，也不會打到真的 Copilot API。

## 檔案結構

| 檔案 | 用途 |
|------|------|
| `index.js` | Express 路由、認證、CORS |
| `proxy.js` | 上游呼叫、OpenAI 直通、Anthropic 端點處理 |
| `anthropic-adapter.js` | 請求／回應轉譯、model 對照、token 估算 |
| `anthropic-stream.js` | SSE 串流狀態機（OpenAI chunk → Anthropic 事件） |
| `token-manager.js` | GitHub device flow、Copilot token 續期 |
| `claude-code.sh` | 健康檢查 + 帶環境變數啟動 Claude Code |

## 注意

GitHub Copilot 的服務條款限制在授權的 client 內使用。用 proxy 把它導到第三方工具屬於灰色地帶，有帳號被停權的風險。

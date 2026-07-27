# Copilot Proxy

輕量 Proxy，把 GitHub Copilot 同時包成 **OpenAI 相容 API** 和 **Anthropic Messages API**，自動管理 Copilot token。

- `/v1/chat/completions` — OpenAI 相容（Dify、Xcode Intelligence、OpenAI SDK…）
- `/v1/messages` — Anthropic Messages（**Claude Code**、Anthropic SDK）

## 快速開始（Docker，推薦）

```bash
# 1. 產生一組隨機 PROXY_API_KEY
printf 'PROXY_API_KEY=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env

# 2. 起容器（restart: unless-stopped，Docker 開著就會自動復活）
docker compose up -d

# 3. GitHub 授權（只需一次，會幫你開瀏覽器並複製代碼）
./auth.sh

# 4. 用它跑 Claude Code
./claude-code.sh
```

Port 只綁 `127.0.0.1`，外部連不到。GitHub token 存在 `./data/` volume，容器重建不用重新授權。

常用指令：

```bash
docker compose logs -f      # 看 log
docker compose restart      # 重啟
docker compose down         # 停掉（授權還留著）
docker compose up -d --build   # 改完 code 重新建置
```

### 本機直跑（不用 Docker）

```bash
npm install
printf 'PROXY_API_KEY=%s\n' "$(openssl rand -hex 24)" > .env && chmod 600 .env
npm start        # 另開一個終端
./auth.sh
./claude-code.sh
```

## 首次授權

```bash
./auth.sh
```

會觸發 GitHub device flow、印出代碼（macOS 順手複製到剪貼簿並開瀏覽器），然後輪詢到授權完成為止。

手動版：

```bash
curl -X POST http://localhost:3456/admin/auth \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"
# 回應會給你 user_code 和 URL，去 https://github.com/login/device 輸入
```

## 搭配 Claude Code

```bash
./claude-code.sh
```

腳本會先檢查 proxy 健康狀態與授權，再帶著環境變數啟動 `claude`。只影響該次執行，不改全域設定。

手動設定的話：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=YOUR_PROXY_API_KEY
export ANTHROPIC_MODEL=claude-sonnet-4.5
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.8
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4.5
claude
```

> 這些必須是上游真的有的 id。先跑一次 `curl /v1/models` 確認，
> 送不存在的會拿到 `400 model_not_supported`。

### Model 名稱對照

Copilot 的模型清單會變（實測就遇到 `claude-sonnet-4` 被下架、多出 `claude-opus-4.7`／`4.8`），
所以 proxy 不硬寫清單 —— 每次啟動去問上游 `GET /models`，快取 10 分鐘。解析順序：

1. 上游清單裡有一模一樣的 id → 直接用（`claude-sonnet-5`、`claude-opus-4.7` 走這條）
2. 去掉日期後綴後有對應的靜態對照、且目標還活著 → 用它
3. 同一階（opus／sonnet／haiku）裡挑版號最高的 → 版號用數值比較，`5` > `4.6`
4. 都不行 → `claude-sonnet-4.5`

實測結果（GitHub Copilot Business，2026-07）：

| Claude Code 送出 | 實際跑 |
|---|---|
| `claude-opus-5` | `claude-opus-4.8` |
| `claude-sonnet-5` | `claude-sonnet-5`（上游真的有） |
| `claude-fable-5` | `claude-sonnet-4.5` |
| `claude-sonnet-4-*` | `claude-sonnet-4.5`（sonnet-4 已下架） |
| `claude-3-5-haiku-*` | `claude-haiku-4.5`（上游真的有 haiku） |

換模型時 log 會留一行警告，每個組合只印一次：

```
⚠️  Copilot 沒有 claude-opus-5，改用 claude-opus-4.8。可用清單見 GET /v1/models
✅ [anthropic] claude-opus-5→claude-opus-4.8 200 (6376ms)
```

查目前上游有什麼、以及某個名稱會被對到哪：

```bash
curl http://localhost:3456/v1/models -H "Authorization: Bearer YOUR_PROXY_API_KEY"
curl "http://localhost:3456/admin/model-map?model=claude-opus-5" -H "Authorization: Bearer YOUR_PROXY_API_KEY"
```

> ⚠️ Claude Code 的 `/model` 只列官方模型名稱，選不到 Copilot 的短名 —— 你選 Fable 5
> 或 Opus 5，實際跑的是上表對照後的模型。要指定確切的 Copilot id，用
> `ANTHROPIC_MODEL` 環境變數（見 `claude-code.sh`），但 Claude Code 裡用 `/model`
> 存過的預設會蓋掉環境變數。

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

清單由上游決定、會變動，所以不寫死在文件裡。**查目前實際可用的：**

```bash
curl http://localhost:3456/v1/models -H "Authorization: Bearer YOUR_PROXY_API_KEY"
```

回應含每個模型的 `context_window`、`max_output_tokens`，以及是否支援
`tool_calls`／`vision`／`streaming`。

參考：2026-07 在 GitHub Copilot Business 上實測到 33 個可對話模型 ——
Anthropic 的 opus 4.5/4.6/4.7/4.8、sonnet 4.5/4.6/5、haiku 4.5，
另有 `gpt-5.x`、`gemini-3.1-pro-preview` 等。`claude-sonnet-4` 已不在清單內。

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
| `auth.sh` | 觸發 GitHub 授權，輪詢到完成 |
| `claude-code.sh` | 健康檢查 + 帶環境變數啟動 Claude Code |
| `docker-compose.yml` | 容器設定（loopback-only、data volume、healthcheck） |

## 注意

GitHub Copilot 的服務條款限制在授權的 client 內使用。用 proxy 把它導到第三方工具屬於灰色地帶，有帳號被停權的風險。

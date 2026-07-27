# CLAUDE.md

給 AI 助理的專案速覽。人看的完整說明在 `README.md`。

## 一句話

拿使用者的 **GitHub Copilot 訂閱**，對外包成 **OpenAI 相容 API**（`/v1/chat/completions`）+ **Anthropic Messages API**（`/v1/messages`），讓 Claude Code、Dify、Xcode 等工具共用一份 Copilot 額度。Node + Express，無資料庫，狀態只有一份 GitHub 憑證檔。

## 兩條請求路徑（最重要的架構決策）

上游 Copilot 對不同模型開放的端點不一樣，所以 proxy 內部分兩條路：

| 路徑 | 適用模型 | 走法 | log 標記 |
|---|---|---|---|
| **passthrough（原生直通）** | Claude 系列 | Copilot 有開原生 `/v1/messages`，請求原封不動轉發，能力零損失 | `[native]` |
| **轉譯層** | gpt / gemini 等 | 只有 `/chat/completions`，需把 Anthropic 格式 ⇄ OpenAI 格式來回翻譯 | `[anthropic]` |

**改任何跟請求/回應格式有關的東西前，先確認你動的是哪條路。** 兩條路能力差異大：轉譯層不支援 extended thinking、prompt caching、真 token 計數（見 README「Copilot 上游缺的能力」）。

## 檔案地圖

| 檔 | 職責 | 改這類需求時看它 |
|---|---|---|
| `index.js` | Express 路由、認證、CORS | 加端點、改 auth header |
| `proxy.js` | 上游呼叫、模型清單快取、兩條路的分流 | 上游行為、模型解析、快取 |
| `anthropic-native.js` | passthrough 能力閘門（thinking 形狀轉換、effort 收斂） | Claude 模型的 thinking 行為 |
| `anthropic-adapter.js` | 請求／回應轉譯、model 對照、token 估算（非 Claude） | gpt/gemini 的格式問題 |
| `anthropic-stream.js` | SSE 串流狀態機（OpenAI chunk → Anthropic 事件，非 Claude） | 串流 bug、SSE 事件 |
| `token-manager.js` | GitHub device flow、Copilot token 續期 | 授權、token 過期 |
| `auth.sh` | 觸發授權、輪詢到完成 | 授權腳本 |
| `claude-code.sh` | 健康檢查 + 帶環境變數啟動 Claude Code | 啟動流程 |

## 模型清單是動態的

**不要在程式或文件裡寫死模型清單。** 上游清單會變（實測遇過 `claude-sonnet-4` 下架、冒出 `opus-4.7/4.8`）。proxy 每次啟動問上游 `GET /models`、快取 10 分鐘，再按 4 段規則解析（完全比對 → 去日期後綴對照 → 同階最高版號 → fallback `claude-sonnet-4.5`）。細節見 README「Model 名稱對照」。

## 開發須知

- **跑測試**：`npm test`（`node --test`）。用本機 mock 上游，不需 GitHub 憑證、不打真 API。改邏輯先跑一遍。
- **依賴極簡**：只有 `express` + `dotenv`。別隨手加依賴。
- **敏感檔**：`.env`（PROXY_API_KEY）、`data/.credentials.json`（GitHub token）已在 `.gitignore`，**絕不可 commit 或印進 log/回應**。
- **設定全走環境變數**：`PROXY_API_KEY`、`COPILOT_DEFAULT_MODEL`、`COPILOT_THINKING_EFFORT` 等，見 README「環境變數」。
- **改完 Docker 版**要 `docker compose up -d --build` 才生效。

## 常見狀況快查

| 症狀 | 方向 |
|---|---|
| `401` | PROXY_API_KEY 不符，或授權過期 → `./auth.sh` 重跑 |
| `400 model_not_supported` | 送了上游沒有的 model id → `curl /v1/models` 看實際清單 |
| thinking 沒作用 | 該模型可能不支援（見 README effort 對照表），或走了轉譯層 |
| 授權一直失敗 | 前提是帳號有 GitHub Copilot 訂閱；device flow 細節在 `token-manager.js` |

# Copilot Proxy

輕量 OpenAI 相容 Proxy，自動管理 GitHub Copilot token。

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
node index.js
```

## 首次授權

```bash
curl -X POST http://localhost:3456/admin/auth \
  -H "Authorization: Bearer YOUR_PROXY_API_KEY"

# 回應會給你 user_code 和 URL
# 去 https://github.com/login/device 輸入 code
# 授權完成後自動生效
```

## API Endpoints

所有端點（除 `/health`）需要 `Authorization: Bearer <PROXY_API_KEY>`。

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

# 健康檢查（不需 API key）
curl http://localhost:3456/health
```

## 可用模型

| Provider | Models |
|----------|--------|
| Anthropic | claude-opus-4.6, claude-opus-4.5, claude-sonnet-4.5, claude-sonnet-4 |
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4, gpt-4.1 |
| Google | gemini-2.5-pro, gemini-3-flash-preview |

## 環境變數

| 變數 | 預設 | 說明 |
|------|------|------|
| `PORT` | `3456` | 監聽 port |
| `PROXY_API_KEY` | (空) | API key，空 = 不驗證 |
| `CREDENTIALS_PATH` | `.credentials.json` | GitHub token 儲存路徑 |

## Dify 設定

1. 模型供應商 → OpenAI-API-compatible
2. API endpoint URL: `https://your-domain/v1`
3. API Key: 你的 `PROXY_API_KEY`
4. Model Name: 上表任一模型名

#!/usr/bin/env bash
# 用 copilot-proxy 當後端啟動 Claude Code
#
#   ./claude-code.sh              # 進入互動模式
#   ./claude-code.sh -p "問題"     # 直接把參數轉給 claude
#
# 這個腳本只設定環境變數，不會改動全域設定；關掉 shell 就恢復原狀。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_URL="${PROXY_URL:-http://localhost:3456}"

# 從 .env 讀 PROXY_API_KEY（沒設就當作免驗證）
if [[ -z "${PROXY_API_KEY:-}" && -f "$SCRIPT_DIR/.env" ]]; then
  PROXY_API_KEY="$(grep -E '^PROXY_API_KEY=' "$SCRIPT_DIR/.env" | tail -1 | cut -d= -f2- || true)"
fi
PROXY_API_KEY="${PROXY_API_KEY:-}"

# ── 前置檢查 ──

if ! command -v claude >/dev/null 2>&1; then
  echo "✗ 找不到 claude 指令。先安裝 Claude Code：" >&2
  echo "  npm install -g @anthropic-ai/claude-code" >&2
  exit 1
fi

HEALTH="$(curl -fsS --max-time 5 "$PROXY_URL/health" 2>/dev/null || true)"

if [[ -z "$HEALTH" ]]; then
  echo "✗ proxy 沒有回應：$PROXY_URL" >&2
  echo "  先啟動它：cd '$SCRIPT_DIR' && npm start" >&2
  exit 1
fi

if [[ "$HEALTH" != *'"authorized":true'* ]]; then
  echo "✗ proxy 還沒完成 GitHub 授權。" >&2
  echo "  執行：curl -X POST $PROXY_URL/admin/auth -H \"Authorization: Bearer \$PROXY_API_KEY\"" >&2
  exit 1
fi

echo "✓ proxy 就緒：$PROXY_URL"

# ── 環境變數 ──

export ANTHROPIC_BASE_URL="$PROXY_URL"

# Claude Code 帶 ANTHROPIC_API_KEY 時送 x-api-key，proxy 的 /v1/messages 兩種都收。
# PROXY_API_KEY 為空時仍要給個非空值，否則 Claude Code 會改用官方登入流程。
export ANTHROPIC_API_KEY="${PROXY_API_KEY:-not-needed}"

# Copilot 的 model 短名。Claude Code 送完整名稱時 proxy 也會自動對照，
# 這裡明確指定可以省掉一層猜測。
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4.5}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-claude-opus-4.6}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-claude-sonnet-4.5}"
# Copilot 沒有 haiku，背景小任務也只能用 sonnet-4
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-claude-sonnet-4}"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-claude-sonnet-4}"

# 少打幾個非必要的端點（proxy 沒實作那些，關掉可以少一些雜訊）
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-1}"

echo "✓ 模型：$ANTHROPIC_MODEL（經 GitHub Copilot）"
echo

exec claude "$@"

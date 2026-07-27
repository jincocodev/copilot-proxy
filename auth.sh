#!/usr/bin/env bash
# GitHub 授權：觸發 device flow，印出代碼，然後等你在瀏覽器完成
#
#   ./auth.sh
#
# 授權結果存在 volume（./data/.credentials.json），容器重建不用重跑。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_URL="${PROXY_URL:-http://localhost:3456}"

if [[ -z "${PROXY_API_KEY:-}" && -f "${SCRIPT_DIR}/.env" ]]; then
  PROXY_API_KEY="$(grep -E '^PROXY_API_KEY=' "${SCRIPT_DIR}/.env" | tail -1 | cut -d= -f2- || true)"
fi
PROXY_API_KEY="${PROXY_API_KEY:-}"

AUTH_HEADER="Authorization: Bearer ${PROXY_API_KEY}"

if ! curl -fsS --max-time 5 "${PROXY_URL}/health" >/dev/null 2>&1; then
  echo "✗ proxy 沒有回應：${PROXY_URL}" >&2
  echo "  先啟動它：cd '${SCRIPT_DIR}' && docker compose up -d" >&2
  exit 1
fi

RESP="$(curl -fsS -X POST "${PROXY_URL}/admin/auth" -H "${AUTH_HEADER}")"

if [[ "${RESP}" == *'"authorized":true'* ]]; then
  echo "✓ 已經授權過了，不用再做。"
  exit 0
fi

# 不依賴 jq
USER_CODE="$(sed -n 's/.*"user_code":"\([^"]*\)".*/\1/p' <<<"${RESP}")"
VERIFY_URI="$(sed -n 's/.*"verification_uri":"\([^"]*\)".*/\1/p' <<<"${RESP}")"

if [[ -z "${USER_CODE}" ]]; then
  echo "✗ 沒拿到 device code，proxy 回應：" >&2
  echo "${RESP}" >&2
  exit 1
fi

echo
echo "  1. 開啟：${VERIFY_URI}"
echo "  2. 輸入代碼：${USER_CODE}"
echo

# macOS 順手幫開瀏覽器並把代碼放進剪貼簿
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "${USER_CODE}" | pbcopy
  echo "  （代碼已複製到剪貼簿）"
fi
if command -v open >/dev/null 2>&1; then
  open "${VERIFY_URI}" >/dev/null 2>&1 || true
fi

echo "等待授權完成…（Ctrl-C 可中斷，授權本身不會被取消）"

for _ in $(seq 1 120); do   # 最多等 10 分鐘
  sleep 5
  if curl -fsS --max-time 5 "${PROXY_URL}/health" 2>/dev/null | grep -q '"authorized":true'; then
    echo "✓ 授權完成。現在可以跑 ./claude-code.sh"
    exit 0
  fi
done

echo "✗ 等超過 10 分鐘還沒完成。device code 可能過期了，重跑 ./auth.sh" >&2
exit 1

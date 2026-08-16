#!/usr/bin/env bash
# scripts/enable-wecom-push-cron.sh
# U7 rollback: 重新启用 wecom-push cron（instant rollback）。
#
# 与 disable-wecom-push-cron.sh 对称：把 function status 设回 active。
# 代码从未删除，此脚本只改触发状态。
#
# 依赖：jq、curl；InsForge 后端可达。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$ROOT/deploy"
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

API_URL="${INSFORGE_URL:-http://localhost:7130}"
API_KEY="${INSFORGE_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "❌ INSFORGE_API_KEY 未设置（见 deploy/.env）" >&2
  exit 1
fi
AUTH="Authorization: Bearer $API_KEY"

SLUG="wecom-push"

echo "▶ 重新启用 ${SLUG} cron..."

# 检查 function 是否存在
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$API_URL/api/functions/$SLUG")
if [ "$HTTP_CODE" != "200" ]; then
  echo "⚠ ${SLUG} function 不存在 (HTTP $HTTP_CODE)，无法启用" >&2
  exit 1
fi

# 读取当前 function 配置
CURRENT=$(curl -sf -H "$AUTH" "$API_URL/api/functions/$SLUG")
CURRENT_CODE=$(echo "$CURRENT" | jq -r '.code // ""')

if [ -z "$CURRENT_CODE" ]; then
  echo "⚠ 无法读取 ${SLUG} function code" >&2
  exit 1
fi

# PUT 更新：status=active（恢复 cron 触发）
ENABLE_BODY=$(jq -n \
  --arg slug "$SLUG" \
  --arg name "$SLUG" \
  --arg desc "${SLUG} edge function" \
  --arg code "$CURRENT_CODE" \
  '{slug:$slug, name:$name, description:$desc, code:$code, status:"active"}')

RESP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "$ENABLE_BODY" "$API_URL/api/functions/$SLUG")

if [ "$RESP_CODE" = "200" ]; then
  echo "✅ ${SLUG} cron 已恢复（status=active）"
  echo "   rollback 完成：旧推送路径已恢复"
else
  echo "❌ 恢复失败 HTTP $RESP_CODE" >&2
  exit 1
fi

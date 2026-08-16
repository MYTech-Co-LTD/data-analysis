#!/usr/bin/env bash
# scripts/disable-wecom-push-cron.sh
# U7 cutover: 禁用 wecom-push cron（不删代码，保 instant rollback）。
#
# 背景：
#   旧路径：wecom-push function → InsForge schedule → 读 reports → 企微 textcard 直投
#   新路径：scheduled_reports job → /api/push → run_push 引擎（四守卫+Novu+bridge+降级）
#
# 此脚本把 wecom-push function 状态设为 inactive（停触发），但不删除 function 代码。
# rollback：运行 scripts/enable-wecom-push-cron.sh 即可恢复旧路径。
#
# 依赖：jq、curl；InsForge 后端可达（dev localhost:7130 / prod 127.0.0.1:7130）。
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

echo "▶ 禁用 ${SLUG} cron..."

# 检查 function 是否存在
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$API_URL/api/functions/$SLUG")
if [ "$HTTP_CODE" != "200" ]; then
  echo "⚠ ${SLUG} function 不存在 (HTTP $HTTP_CODE)，跳过"
  exit 0
fi

# 读取当前 function 配置（保留 code）
CURRENT=$(curl -sf -H "$AUTH" "$API_URL/api/functions/$SLUG")
CURRENT_CODE=$(echo "$CURRENT" | jq -r '.code // ""')

if [ -z "$CURRENT_CODE" ]; then
  echo "⚠ 无法读取 ${SLUG} function code，跳过"
  exit 1
fi

# PUT 更新：status=inactive（停 cron 触发，保留代码可手动 invoke / 回退重启用）
DISABLE_BODY=$(jq -n \
  --arg slug "$SLUG" \
  --arg name "$SLUG" \
  --arg desc "${SLUG} edge function (cron disabled by U7 cutover)" \
  --arg code "$CURRENT_CODE" \
  '{slug:$slug, name:$name, description:$desc, code:$code, status:"inactive"}')

RESP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "$DISABLE_BODY" "$API_URL/api/functions/$SLUG")

if [ "$RESP_CODE" = "200" ]; then
  echo "✅ ${SLUG} cron 已禁用（status=inactive）"
  echo "   代码保留，可手动 invoke 测试"
  echo "   rollback: bash scripts/enable-wecom-push-cron.sh"
else
  echo "❌ 禁用失败 HTTP $RESP_CODE" >&2
  exit 1
fi

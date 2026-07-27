#!/bin/bash
# 每日明细(parquet) vs 聚合(pg) 对账 — 抓 stale/丢数据/glob误匹配
# 09:10 跑（08:0x 采集 + compute 之后，API 稳定）
# crontab: 10 9 * * * /opt/data-analytics-platform/scripts/cron-reconcile.sh >> /var/log/reconcile.log 2>&1
# 失败(exit!=0)发企微运维告警(WECOM_OPS)
set -a; . /opt/data-analytics-platform/deploy/.env; set +a
cd /opt/data-analytics-platform || exit 1

docker exec deploy-duckdb-1 mkdir -p /app/scripts 2>/dev/null
docker cp scripts/reconcile-check.js deploy-duckdb-1:/app/scripts/reconcile-check.js >/dev/null

TS=$(date '+%F %T')
OUT=$(docker exec deploy-duckdb-1 node /app/scripts/reconcile-check.js 7 2>&1)
CODE=$?
echo "[$TS] exit=$CODE"
echo "$OUT"

# 失败发企微告警
if [ $CODE -ne 0 ] && [ -n "$WECOM_OPS_SECRET" ] && [ -n "$WECOM_CORP_ID" ]; then
  TOKEN=$(curl -s --max-time 10 "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${WECOM_CORP_ID}&corpsecret=${WECOM_OPS_SECRET}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  if [ -n "$TOKEN" ]; then
    BODY=$(printf '⚠️ 数据对账失败(exit=%s)\n%s' "$CODE" "$(echo "$OUT" | grep -E "✗|FAIL|ERR" | head -15)")
    # jq 转 JSON 字符串（无 jq 用 python3 兜底）
    if command -v jq >/dev/null 2>&1; then
      CONTENT=$(printf '%s' "$BODY" | jq -Rs .)
    else
      CONTENT=$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')
    fi
    curl -s --max-time 10 -X POST "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${TOKEN}" \
      -H 'Content-Type: application/json' \
      -d "{\"touser\":\"${NOTIFY_DEFAULT_TUSERS}\",\"msgtype\":\"text\",\"agentid\":${WECOM_OPS_AGENT_ID},\"text\":{\"content\":${CONTENT}}}" >/dev/null
    echo "[$TS] 已发企微运维告警"
  fi
fi
exit 0

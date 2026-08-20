#!/usr/bin/env bash
# scripts/apply-wecom-plugin-patches.sh
# 应用 wecom 插件的本地补丁（openclaw 更新/插件收敛后会被覆盖，需重跑本脚本）：
#   1) pristine 恢复（npm 原始包 @wecom/wecom-openclaw-plugin@2026.5.7 的三个文件）
#   2) embed   —— 模板卡片嵌入流式回复（文本+卡片一条消息）
#   3) emoji   —— 只剔除 📊🔥📈，其余 emoji 保留；不剥离 markdown
# 幂等：基于 pristine 全量重建，任意状态可重跑。
# 用法（服务器上）：
#   bash scripts/apply-wecom-plugin-patches.sh
set -euo pipefail

STATE_DIR="${1:-/opt/data-analytics-platform/openclaw/state}"
PLUGIN_GLOB="$STATE_DIR/npm/projects/wecom-wecom-openclaw-plugin-*/node_modules/@wecom/wecom-openclaw-plugin/dist/src"

echo "== 定位 wecom 插件 src 目录 =="
SRC_DIR="$(ls -d $PLUGIN_GLOB 2>/dev/null | head -1 || true)"
if [ -z "$SRC_DIR" ]; then
  echo "❌ 未找到插件目录（glob: $PLUGIN_GLOB）" >&2
  exit 1
fi
echo "  plugin src: $SRC_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_DIR="$SCRIPT_DIR/wecom-plugin-patches"

# 备份当前（含补丁）状态，便于回滚
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PATCH_DIR/backup-$TS"
for f in template-card-manager.js monitor.js message-sender.js; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$PATCH_DIR/backup-$TS/$f"
done
echo "  backup -> $PATCH_DIR/backup-$TS"

# 应用补丁（确定性重建）
echo "== 应用补丁 =="
python3 "$PATCH_DIR/patch_apply_all.py" "$SRC_DIR"

# 语法校验 + 重启 openclaw（容器内路径 = 主机路径 state→/home/node/.openclaw）
CONTAINER="${OPENCLAW_CONTAINER:-deploy-openclaw-1}"
INNER_SRC="${SRC_DIR//\/opt\/data-analytics-platform\/openclaw\/state\//\/home\/node\/.openclaw\/}"
echo "== 语法校验（容器内: $INNER_SRC）=="
docker exec "$CONTAINER" sh -c "for f in template-card-manager.js monitor.js message-sender.js; do node --check $INNER_SRC/\$f || exit 1; done && echo SYNTAX_OK"
echo "== 重启 openclaw =="
docker restart "$CONTAINER" >/dev/null && sleep 12
docker ps --filter name="$CONTAINER" --format "{{.Status}}"
echo "✅ 补丁应用完成（openclaw 更新后重跑本脚本恢复）"

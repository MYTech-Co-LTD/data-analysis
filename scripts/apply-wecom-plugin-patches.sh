#!/usr/bin/env bash
# scripts/apply-wecom-plugin-patches.sh
# 恢复 wecom 插件为 pristine（npm 原始包 @wecom/wecom-openclaw-plugin@2026.5.7）。
# 说明（2026-08-20 决策）：此前所有本地补丁（emoji 黑名单/thinking 事件/embed）已取消——
#   补丁引发 import 损坏、卡片嵌入不渲染、markdown 原样等问题，得不偿失。
#   格式约束改由 retail-query SKILL.md 引导模型输出干净纯文本。插件保持原生。
# openclaw 更新/插件收敛后插件文件会被覆盖为原生，无需本脚本；如需回到已知良好态可跑本脚本。
# 用法：bash scripts/apply-wecom-plugin-patches.sh
set -euo pipefail

STATE_DIR="${1:-/opt/data-analytics-platform/openclaw/state}"
PLUGIN_GLOB="$STATE_DIR/npm/projects/wecom-wecom-openclaw-plugin-*/node_modules/@wecom/wecom-openclaw-plugin/dist/src"

echo "== 定位 wecom 插件 src 目录 =="
SRC_DIR="$(ls -d $PLUGIN_GLOB 2>/dev/null | head -1 || true)"
if [ -z "$SRC_DIR" ]; then
  echo "❌ 未找到插件目录" >&2
  exit 1
fi
echo "  plugin src: $SRC_DIR"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIST_DIR="$SCRIPT_DIR/wecom-plugin-patches/pristine"

# 备份当前状态
TS="$(date +%Y%m%d-%H%M%S)"
BK="$SCRIPT_DIR/wecom-plugin-patches/backup-$TS"
mkdir -p "$BK"
for f in template-card-manager.js monitor.js message-sender.js; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$BK/$f"
done
echo "  backup -> $BK"

# 恢复 pristine
for f in template-card-manager.js monitor.js message-sender.js; do
  cp "$PRIST_DIR/$f" "$SRC_DIR/$f"
  echo "  restored $f"
done

CONTAINER="${OPENCLAW_CONTAINER:-deploy-openclaw-1}"
INNER_SRC="${SRC_DIR//\/opt\/data-analytics-platform\/openclaw\/state\//\/home\/node\/.openclaw\/}"
echo "== 语法校验 =="
docker exec "$CONTAINER" sh -c "for f in template-card-manager.js monitor.js message-sender.js; do node --check $INNER_SRC/\$f || exit 1; done && echo SYNTAX_OK"
echo "== 重启 openclaw =="
docker restart "$CONTAINER" >/dev/null && sleep 12
docker ps --filter name="$CONTAINER" --format "{{.Status}}"
echo "✅ 插件已恢复 pristine（无本地补丁）"

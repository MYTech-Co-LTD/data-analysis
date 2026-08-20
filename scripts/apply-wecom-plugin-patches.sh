#!/usr/bin/env bash
# scripts/apply-wecom-plugin-patches.sh
# 应用 wecom 插件的本地补丁（openclaw 更新/插件收敛后会被覆盖，需重跑本脚本）：
#   1) embed   —— 模板卡片嵌入流式回复（stream_with_template_card），文本+卡片一条消息
#   2) emoji   —— 剥离回复文本与卡片字段的 emoji 图标（AI 味重）
# 幂等：已打补丁的文件会检测标记并跳过。
# 用法：在服务器执行（或本机 scp 后执行）：
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

# 备份
TS="$(date +%Y%m%d-%H%M%S)"
for f in template-card-manager.js monitor.js message-sender.js; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$SRC_DIR/$f.bak-$TS"
done
echo "  backup done ($TS)"

# 应用补丁（python3 幂等：带标记检测）
for p in patch_embed.py patch_emoji.py patch_mdstrip.py; do
  if [ -f "$PATCH_DIR/$p" ]; then
    echo "== 应用 $p =="
    python3 "$PATCH_DIR/$p" || echo "  ⚠ $p 失败或已应用（幂等跳过）"
  fi
done

# 语法校验 + 重启 openclaw（容器名可配）
CONTAINER="${OPENCLAW_CONTAINER:-deploy-openclaw-1}"
echo "== 语法校验 =="
docker exec "$CONTAINER" sh -c "node --check $SRC_DIR/template-card-manager.js && node --check $SRC_DIR/monitor.js && node --check $SRC_DIR/message-sender.js && echo SYNTAX_OK"
echo "== 重启 openclaw =="
docker restart "$CONTAINER" >/dev/null && sleep 12
docker ps --filter name="$CONTAINER" --format "{{.Status}}"
echo "✅ 补丁应用完成（插件更新后需重跑本脚本）"

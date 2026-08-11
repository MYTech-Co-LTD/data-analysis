#!/usr/bin/env bash
# scripts/guard-contract-drift.sh
# 守护依赖方向铁律（spec 2026-08-11-modular-plugin-design §4.4；P1 起严执）：
#   web/lib/jobs/** 与 web/lib/report-center/boards/** 禁止互 import（插件边界）。
#   web/lib/contracts 是唯一共享区——两边都允许 import 它。
# P0 骨架先行：jobs/、boards/ 尚未创建，扫描为空即通过；P1（jobs/）/P4（boards/）落地后即生效。
#
# 规则：
#   1) web/lib/jobs/** 不得 import '.../report-center/boards/**'
#   2) web/lib/report-center/boards/** 不得 import '.../jobs/**'
#
# 白名单：scripts/guard-contract-drift.allowlist，每行 path[:line]，# 开头为注释。
# 白名单语义：命中的 file:line 整行豁免；只填 path 则该文件所有命中豁免（少用）。
# 默认拒绝——除非架构 owner 明确 approve 的合理例外，不要添加。
#
# 退出码：0 通过；1 违反。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$SCRIPT_DIR/guard-contract-drift.allowlist"
hit=0
violations=""

# 把命中行按 file:line:snippet 格式化，过滤白名单，输出剩余（同 guard-branch-num.sh）
filter_allowlist() {
  local f l rest f_esc
  while IFS= read -r line; do
    f="${line%%:*}"
    rest="${line#*:}"
    l="${rest%%:*}"
    # 转义路径中的正则元字符：先 / 后 .
    f_esc="${f//\//\\/}"
    f_esc="${f_esc//./\\.}"
    # 跳过白名单：精确 file:line 或 整文件
    if [ -f "$ALLOWLIST" ]; then
      if grep -qE "^${f_esc}:${l}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null; then continue; fi
      if grep -qE "^${f_esc}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null; then continue; fi
    fi
    echo "$line"
  done
}

report() {
  local line="$1"
  echo "❌ $line"
  violations="${violations}${line}\n"
  hit=1
}

echo "[guard] 扫描 web/lib/jobs/** → import report-center/boards/**（插件边界，禁止）..."
while IFS= read -r line; do
  if [ -n "$line" ]; then
    report "$line"
  fi
done < <(
  grep -rnE "from\s+['\"][^'\"]*report-center/boards|import\(\s*['\"][^'\"]*report-center/boards" \
    web/lib/jobs 2>/dev/null \
  | grep -vE "(node_modules|\.next|/out/)" \
  | filter_allowlist
)

echo "[guard] 扫描 web/lib/report-center/boards/** → import jobs/**（插件边界，禁止）..."
while IFS= read -r line; do
  if [ -n "$line" ]; then
    report "$line"
  fi
done < <(
  grep -rnE "from\s+['\"][^'\"]*lib/jobs|from\s+['\"][^'\"]*/jobs/|import\(\s*['\"][^'\"]*lib/jobs|import\(\s*['\"][^'\"]*/jobs/" \
    web/lib/report-center/boards 2>/dev/null \
  | grep -vE "(node_modules|\.next|/out/)" \
  | filter_allowlist
)

if [ "$hit" -ne 0 ]; then
  echo "[guard] ❌ 违反依赖方向铁律：jobs/* 与 report-center/boards/* 禁止互 import（spec §4.4）"
  echo "[guard] 违规清单："
  echo -e "$violations"
  echo "[guard] 如属合理例外，请在 scripts/guard-contract-drift.allowlist 加注并写理由（默认拒绝）"
  exit 1
fi
echo "[guard] ✅ 通过"

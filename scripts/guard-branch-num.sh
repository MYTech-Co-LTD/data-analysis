#!/usr/bin/env bash
# scripts/guard-branch-num.sh
# 守护门店键铁律（spec 2026-07-28 §3.7）：禁止 branch_num 单独 join/去重/.eq
# 门店键 = (system_book_code, branch_num) 复合 或 派生 branch_number。
# branch_num 跨账套重复（3120 与 64188 共享 128 个号），单独使用会塌缩/错配。
#
# 规则：
#   1) JOIN ON x.branch_num = y.branch_num —— 同行须伴 system_book_code 或 branch_number
#   2) .eq("branch_num" / .eq('branch_num' —— 文件内须伴 system_book_code 或 branch_number
#   3) WHERE branch_num = v_xxx 单列去重/LIMIT 1（修自 063 根因）—— 须伴 system_book_code
#
# 白名单：scripts/guard-branch-num.allowlist，每行 path[:line]，# 开头为注释。
# 白名单语义：命中的 file:line 整行豁免；只填 path 则该文件所有命中豁免（少用）。
#
# 退出码：0 通过；1 违反。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$SCRIPT_DIR/guard-branch-num.allowlist"
hit=0
violations=""

# 把命中行按 file:line:snippet 格式化，过滤白名单，输出剩余
# 输入：stdin = grep -nE 的原始输出（file:line:content）
filter_allowlist() {
  local f l rest key f_only
  while IFS= read -r line; do
    f="${line%%:*}"
    rest="${line#*:}"
    l="${rest%%:*}"
    key="$f:$l"
    f_only="$f"
    # 跳过白名单：精确 file:line 或 整文件
    if [ -f "$ALLOWLIST" ]; then
      if grep -qE "^${f//\//\\/}:${l}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null; then continue; fi
      if grep -qE "^${f//\//\\/}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null; then continue; fi
    fi
    echo "$line"
  done
}

echo "[guard] 扫描 ON x.branch_num = y.branch_num（同行须伴 system_book_code/branch_number）..."
while IFS= read -r line; do
  if [ -n "$line" ]; then
    echo "❌ $line"
    violations="${violations}${line}\n"
    hit=1
  fi
done < <(
  grep -rnE "ON\s+\w+\.branch_num\s*=\s*\w+\.branch_num" \
    database/migrations web/app web/lib services 2>/dev/null \
  | grep -viE "system_book_code|branch_number" \
  | grep -vE "(_regression|node_modules|\.next|/out/)" \
  | filter_allowlist
)

echo "[guard] 扫描 WHERE branch_num = v_xxx 单列去重/LIMIT 1（须伴 system_book_code）..."
while IFS= read -r line; do
  if [ -n "$line" ]; then
    echo "❌ $line"
    violations="${violations}${line}\n"
    hit=1
  fi
done < <(
  grep -rnE "WHERE\s+\w*\.?branch_num\s*=\s*v_\w+|AND\s+\w*\.?branch_num\s*=\s*v_\w+\s+LIMIT\s+1" \
    database/migrations web/app web/lib services 2>/dev/null \
  | grep -viE "system_book_code|branch_number" \
  | grep -vE "(_regression|node_modules|\.next|/out/)" \
  | filter_allowlist
)

echo "[guard] 扫描 .eq('branch_num') / .eq(\"branch_num\")（文件内须伴 system_book_code/branch_number）..."
for f in $(grep -rlE '\.eq\(["'\'']branch_num["'\'']' web/app web/lib 2>/dev/null | grep -vE "node_modules|\.next|/out/"); do
  if ! grep -qE "system_book_code|branch_number" "$f"; then
    # 整文件违反；按白名单粒度（file 级）过滤
    skip=0
    if [ -f "$ALLOWLIST" ] && grep -qE "^${f//\//\\/}(\s|\$|#)" "$ALLOWLIST" 2>/dev/null; then
      skip=1
    fi
    if [ "$skip" -eq 0 ]; then
      echo "❌ $f 用 .eq(\"branch_num\") 但文件内无 system_book_code/branch_number"
      violations="${violations}$f 用 .eq(\"branch_num\") 但文件内无 system_book_code/branch_number\n"
      hit=1
    fi
  fi
done

if [ "$hit" -ne 0 ]; then
  echo "[guard] ❌ 违反门店键铁律，请改用复合键(system_book_code,branch_num)或 branch_number"
  echo "[guard] 如属预先存在的遗留代码（spec §4 audit-only），请在 scripts/guard-branch-num.allowlist 加注并写理由"
  exit 1
fi
echo "[guard] ✅ 通过"

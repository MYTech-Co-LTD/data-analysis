#!/usr/bin/env bash
# scripts/guard-migration-spec.sh
# 守护迁移 spec 关联铁律（2026-08-19 用户裁定，起因：迁移 199 真相源切换未经 spec 先行实施）：
#   含破坏性 SQL（DELETE FROM / DROP / TRUNCATE）的 database/migrations/*.sql
#   必须在文件头注释中声明 spec 关联，且 spec 文件存在于 docs/superpowers/specs/。
#
# 关联约定（SQL 注释行，建议放文件头）：
#   -- spec: docs/superpowers/specs/<name>.md
#
# 规则：
#   1) 迁移含破坏性语句 → 必须有 -- spec: 引用且目标文件存在，否则拒绝
#   2) 无破坏性语句的迁移不受约束（幂等 CREATE/ALTER ADD 正常走）
#
# 白名单：scripts/guard-migration-spec.allowlist，每行一个迁移文件名（存量豁免）。
# 默认拒绝——除非架构 owner 明确 approve 的合理例外，不要添加。
#
# 退出码：0 通过；1 违反。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

MIGRATIONS_DIR="$ROOT/database/migrations"
SPECS_DIR="$ROOT/docs/superpowers/specs"
ALLOWLIST="$SCRIPT_DIR/guard-migration-spec.allowlist"

# 破坏性语句模式（注释行除外；大小写不敏感；_IF EXISTS 变体由关键词覆盖）
DESTRUCTIVE_RE='^[[:space:]]*(DELETE[[:space:]]+FROM|DROP[[:space:]]+(TABLE|VIEW|COLUMN|CONSTRAINT|INDEX|FUNCTION|POLICY|TRIGGER)|TRUNCATE)'

hit=0

# 存量迁移打白名单（2026-08-19 之前的历史迁移，spec 铁律自此迁移 200 起生效）
is_allowlisted() {
  [ -f "$ALLOWLIST" ] && grep -qE "^$1(\s|\$|#)" "$ALLOWLIST" 2>/dev/null
}

for sql in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$sql" ] || continue
  name="$(basename "$sql")"

  # 破坏性检测（跳过注释行）
  if ! grep -vE '^[[:space:]]*--' "$sql" | grep -iqE "$DESTRUCTIVE_RE"; then
    continue
  fi

  if is_allowlisted "$name"; then
    echo "⏭  ${name}（白名单豁免）"
    continue
  fi

  # 提取 -- spec: 引用（取第一个）
  spec_ref="$(grep -oE '^-- spec:[[:space:]]*\S+' "$sql" | head -1 | sed 's/^-- spec:[[:space:]]*//')"
  if [ -z "$spec_ref" ]; then
    echo "❌ $name: 含破坏性 SQL（DELETE/DROP/TRUNCATE）但未声明 spec 关联"
    echo "   修复：在文件头加 '-- spec: docs/superpowers/specs/<name>.md' 并先提交该 spec 文档"
    hit=1
    continue
  fi
  if [ ! -f "$ROOT/$spec_ref" ]; then
    echo "❌ $name: 声明的 spec '$spec_ref' 不存在（spec 必须先于/随迁移提交）"
    hit=1
    continue
  fi
  echo "✓ $name → $spec_ref"
done

if [ "$hit" -ne 0 ]; then
  echo ""
  echo "❌ Guard: 迁移 spec 关联检查未通过（破坏性迁移必须关联 docs/superpowers/specs/ 设计文档）"
  exit 1
fi

echo "✅ Guard: 迁移 spec 关联通过"

#!/usr/bin/env bash
# scripts/guard-compute-glob.sh
# 守护 compute source glob：禁止 **/*.parquet（会同时匹配 all.parquet + 门店分片，内容相同 → SUM 翻倍）。
# /transform 写 parquet 时同时写 all.parquet（全量）+ 门店分片（如 branch_num_99.parquet，与 all 内容相同）。
# compute 的 source_pattern / read_parquet 必须用 **/all.parquet（只读 all），与老表 daily_* 一致。
#
# 此坑历史踩过两次：059 修过一次，Phase2（108/110/111）又重新引入，116 再修。
# 白名单：scripts/guard-compute-glob.allowlist（已含 `**/*.parquet` 的历史文件，多为被后续迁移覆盖或本身就是修复）。
# 新迁移若 source_pattern / read_parquet 用 **/*.parquet → CI fail。
#
# 退出码：0 通过；1 违反。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

ALLOWLIST="$SCRIPT_DIR/guard-compute-glob.allowlist"
BAD='**/*.parquet'   # 固定串：**/all.parquet 不含此子串，不会被误命中

violations=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  # 跳过白名单文件（整文件豁免）
  if [ -f "$ALLOWLIST" ] && grep -qxF "$file" "$ALLOWLIST"; then
    continue
  fi
  violations="$violations\n$line"
done < <(grep -rnF "$BAD" database/migrations/*.sql 2>/dev/null || true)

if [ -n "$violations" ]; then
  echo "❌ guard-compute-glob: 发现 **/*.parquet（会读 all+分片致 SUM 翻倍），须改 **/all.parquet:" >&2
  printf '%b\n' "$violations" >&2
  echo "（若为历史遗留且已被后续迁移覆盖，加进 scripts/guard-compute-glob.allowlist）" >&2
  exit 1
fi

echo "✅ guard-compute-glob: 无 **/*.parquet（compute glob 全部用 **/all.parquet）"

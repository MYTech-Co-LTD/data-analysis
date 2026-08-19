#!/usr/bin/env bash
# scripts/migrate.sh
# 按文件名顺序执行 database/migrations/*.sql（幂等，可重复跑）。
# 依赖：postgres 容器已运行（base compose），migrations 已挂载到容器 /migrations。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
MIGRATIONS_DIR="$ROOT/database/migrations"

cd "$DEPLOY_DIR"

# 从 .env 读 DB 凭证（缺省用默认）
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi
PGUSER="${POSTGRES_USER:-postgres}"
PGDB="${POSTGRES_DB:-insforge}"

# 确认 postgres 就绪
if ! docker compose exec -T postgres pg_isready -U "$PGUSER" >/dev/null 2>&1; then
  echo "❌ postgres 未就绪，请先：cd deploy && docker compose up -d postgres" >&2
  exit 1
fi

echo "▶ 执行数据库迁移（${MIGRATIONS_DIR}）..."

# 迁移 spec 铁律（2026-08-19）：破坏性迁移必须关联 spec（本地 guard 脚本在则检查；
# 服务器部署包可能未携带 docs/specs（migrate 阶段只 rsync database/），缺失时降级跳过——
# CI quality job（全量 checkout）已是硬门禁，此处仅防御性复检。
if [ -x "${ROOT}/scripts/guard-migration-spec.sh" ] && [ -d "${ROOT}/docs/superpowers/specs" ]; then
  bash "${ROOT}/scripts/guard-migration-spec.sh"
fi
shopt -s nullglob
for sql in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$sql")"
  echo "  · $name"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
    -U "$PGUSER" -d "$PGDB" -f "/migrations/$name"
done
shopt -u nullglob

# 生成器产物（services/semantic-generator 产出，DROP+CREATE 幂等）
# ⚠️ 必须按字节序(LC_ALL=C)执行：base 视图文件先于其 _qa 对账视图（'.' < '_'），
#    否则 locale 排序把 _qa 放前，_qa 依赖基视图会阻塞基视图 DROP VIEW IF EXISTS。
GENERATED_DIR="$ROOT/database/generated"
if [ -d "$GENERATED_DIR" ]; then
  echo "▶ 执行生成器产物（${GENERATED_DIR}，字节序 base<qa）..."
  shopt -s nullglob
  # macOS 默认 bash 3.2 无 mapfile：用 $(...) + 字节序排序的可移植写法（行为与 mapfile 版一致）
  for sql in $(printf '%s\n' "$GENERATED_DIR"/*.sql | LC_ALL=C sort); do
    name="$(basename "$sql")"
    echo "  · $name"
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
      -U "$PGUSER" -d "$PGDB" -f "/generated/$name"
  done
  shopt -u nullglob
fi

echo "✅ 迁移完成"

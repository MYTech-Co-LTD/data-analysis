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
shopt -s nullglob
for sql in "$MIGRATIONS_DIR"/*.sql; do
  name="$(basename "$sql")"
  echo "  · $name"
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
    -U "$PGUSER" -d "$PGDB" -f "/migrations/$name"
done
shopt -u nullglob

# 生成器产物（services/semantic-generator 产出，DROP+CREATE 幂等）
GENERATED_DIR="$ROOT/database/generated"
if [ -d "$GENERATED_DIR" ]; then
  echo "▶ 执行生成器产物（${GENERATED_DIR}）..."
  shopt -s nullglob
  for sql in "$GENERATED_DIR"/*.sql; do
    name="$(basename "$sql")"
    echo "  · $name"
    docker compose exec -T postgres psql -v ON_ERROR_STOP=1 \
      -U "$PGUSER" -d "$PGDB" -f "/generated/$name"
  done
  shopt -u nullglob
fi

echo "✅ 迁移完成"

#!/usr/bin/env bash
# scripts/deploy.sh
# 服务器一键部署（由 GitHub Actions 经 SSH 触发，或在服务器上手动执行）。
# 顺序刻意安排以解决 anon_key 的 chicken-egg：先起后端 → 取/校验 anon_key → 再 build 前端。
# 依赖：docker（含 compose 插件）、jq、curl、git。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT/deploy"
cd "$DEPLOY_DIR"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
API_URL="${INSFORGE_URL:-http://localhost:7130}"

echo "==== [1/5] 同步代码 ===="
cd "$ROOT"
# 代码已由 GHA rsync 同步；git pull 仅作手动部署兜底，失败不阻断。
# 必须用 timeout 包裹：服务器访问 GitHub 偶发 GnuTLS/TLS 中断，git pull 会【挂死】
# （不报错也不退出），导致整个 deploy.sh 卡住。20s 超时后按失败处理走 rsync 的代码。
timeout 20 git pull --ff-only 2>/dev/null || echo "  · 跳过 git pull（代码由 GHA rsync 提供，或 git 超时）"
cd "$DEPLOY_DIR"

echo "==== [2/5] 起后端栈并等待就绪 ===="
$COMPOSE up -d postgres postgrest deno insforge
echo "  等待 insforge 接受连接..."
ready=0
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then
    echo "  ✅ insforge 就绪（HTTP ${code}）"
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" = 1 ] || { echo "  ❌ insforge 30s 内未就绪" >&2; exit 1; }

echo "==== [3/5] 数据库迁移 ===="
bash "$ROOT/scripts/migrate.sh"

# 刷 PostgREST schema 缓存：migrate 改表/视图后必须重启，否则 400 "Could not find ... in the schema cache"
echo "  · restart postgrest（刷 schema 缓存）"
$COMPOSE restart postgrest

echo "==== [4/5] 部署 edge functions + secrets ===="
# function 部署为"尽力而为"：失败不阻断前端构建（function 可用 MCP 单独更新）
bash "$ROOT/scripts/deploy-functions.sh" || echo "⚠ function 部署步骤失败，跳过继续前端构建（function 可用 MCP 单独更新）"

# 前端 build 所需的 anon_key（build-time 内联，必须此时就位）
if [ -z "${NEXT_PUBLIC_INSFORGE_ANON_KEY:-}" ]; then
  echo "" >&2
  echo "❌ deploy/.env 缺 NEXT_PUBLIC_INSFORGE_ANON_KEY —— 前端无法 build。" >&2
  echo "   这是首次部署的必经步骤：后端已起，请获取本实例的 anon_key 填入 deploy/.env，" >&2
  echo "   再重跑本脚本。获取方式：用 INSFORGE_API_KEY 调 InsForge 的 get-anon-key，" >&2
  echo "   或在 dashboard（http://服务器IP:7130 暂时映射后）查看。" >&2
  exit 1
fi
: "${NEXT_PUBLIC_INSFORGE_URL:=https://${DOMAIN:-localhost}}"
export NEXT_PUBLIC_INSFORGE_URL
echo "  · 前端将连接 $NEXT_PUBLIC_INSFORGE_URL"

echo "==== [5/5] 服务器构建前端镜像 → 推天翼云 → 起网关 ===="
WEB_IMAGE="registry-crs-xinan1.ctyun.cn/hookflow/data-analysis-web:latest"
DUCKDB_IMAGE="registry-crs-xinan1.ctyun.cn/hookflow/duckdb-service:latest"

# 登录天翼云（服务器国内 → 天翼云国内，push 快；凭证由 GHA secrets 经 SSH 注入）
if [ -n "${CTYUN_USERNAME:-}" ] && [ -n "${CTYUN_PASSWORD:-}" ]; then
  echo "$CTYUN_PASSWORD" | docker login registry-crs-xinan1.ctyun.cn -u "$CTYUN_USERNAME" --password-stdin
  echo "  ✅ 已登录天翼云镜像服务"
else
  echo "  ⚠ CTYUN_USERNAME/CTYUN_PASSWORD 未注入，跳过 push（仅本地 build）" >&2
fi

# 构建 DuckDB 服务镜像（用于 /compute 端点）；base image 走 xuanyuan.run 偶发不可达时 pull ctyun latest 兜底，不阻断 web 部署
echo "  · docker build $DUCKDB_IMAGE"
docker build -t "$DUCKDB_IMAGE" "$ROOT/services" 2>&1 || {
  echo "  ⚠ DuckDB build 失败(可能 base image registry xuanyuan.run 不可达),改 pull ctyun latest"
  docker pull "$DUCKDB_IMAGE" || echo "  ⚠ pull 也失败,保持现有 duckdb 容器镜像"
}
docker push "$DUCKDB_IMAGE" || echo "  ⚠ push DuckDB 镜像失败，使用本地镜像继续"

# 服务器本地 build（base 镜像走 xuanyuan.run、npm 走 npmmirror，均国内链路）
echo "  · docker build $WEB_IMAGE"
docker build \
  --build-arg NEXT_PUBLIC_INSFORGE_URL="$NEXT_PUBLIC_INSFORGE_URL" \
  --build-arg NEXT_PUBLIC_INSFORGE_ANON_KEY="$NEXT_PUBLIC_INSFORGE_ANON_KEY" \
  --build-arg NEXT_PUBLIC_WECOM_CORP_ID="${WECOM_CORP_ID:-}" \
  --build-arg NEXT_PUBLIC_WECOM_AGENT_ID="${WECOM_AGENT_ID:-}" \
  --build-arg NEXT_PUBLIC_WECOM_REDIRECT_URI="https://${DOMAIN}/auth/callback" \
  --build-arg NEXT_PUBLIC_CASDOOR_ISSUER="${NEXT_PUBLIC_CASDOOR_ISSUER:-}" \
  --build-arg NEXT_PUBLIC_CASDOOR_CLIENT_ID="${NEXT_PUBLIC_CASDOOR_CLIENT_ID:-}" \
  --build-arg NEXT_PUBLIC_CASDOOR_REDIRECT_URI="${NEXT_PUBLIC_CASDOOR_REDIRECT_URI:-}" \
  -t "$WEB_IMAGE" \
  "$ROOT/web"

# 推天翼云（国内→国内）；失败不阻断 —— 本地 build 的同名镜像可直接起
docker push "$WEB_IMAGE" || echo "  ⚠ push 天翼云失败，使用本地镜像继续"

# 由 DOMAIN / SSO_DOMAIN 生成 nginx user_conf.d/ 下各 server.conf（模板在 nginx/*.tpl）。
# 模板绝不能留在 user_conf.d/ —— 它会被挂载进容器，certbot 会拿字面量 __DOMAIN__ 去签证书而失败。
mkdir -p nginx/user_conf.d

if [ -n "${DOMAIN:-}" ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" nginx/server.conf.tpl > nginx/user_conf.d/server.conf
  echo "  ✅ nginx 配置已生成（server_name ${DOMAIN}）"
else
  echo "  ⚠ DOMAIN 未设置，nginx server.conf 未生成 —— Let's Encrypt 签发会失败" >&2
fi

# 由 SSO_DOMAIN 生成 nginx sso.conf（Casdoor SSO 反代 → casdoor:8000）。
# 机制与 server.conf 相同：模板 + sed → user_conf.d/，nginx-certbot 镜像自动签发证书。
if [ -n "${SSO_DOMAIN:-}" ]; then
  sed "s/__SSO_DOMAIN__/$SSO_DOMAIN/g" nginx/sso.conf.tpl > nginx/user_conf.d/sso.conf
  echo "  ✅ nginx SSO 配置已生成（server_name ${SSO_DOMAIN} → casdoor:8000）"
else
  echo "  ⚠ SSO_DOMAIN 未设置，nginx sso.conf 未生成（Casdoor SSO 不可达）" >&2
fi

# 起 web（用本地刚 build 的镜像，--force-recreate 确保用新镜像）+ nginx（首次自动 pull xuanyuan.run 公共镜像）+ duckdb
$COMPOSE up -d --force-recreate web nginx duckdb

echo ""
echo "==== ✅ 部署完成 ===="
$COMPOSE ps
echo ""
echo "访问：https://${DOMAIN:-<domain>}"
echo "（首次启动 nginx-certbot 会自动签发 Let's Encrypt 证书，约需 30-60s）"

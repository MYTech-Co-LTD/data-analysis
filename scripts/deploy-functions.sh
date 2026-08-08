#!/usr/bin/env bash
# scripts/deploy-functions.sh
# 遍历 functions/*/index.js，用 INSFORGE_API_KEY 直调 InsForge API 部署每个 edge function
# （OSS 的 `functions deploy` CLI 走 cloud OAuth、headless 不可用，故直调 API）。
# 随后把 WECOM_* 注入为 function secret（function 用 Deno.env.get 读取）。
# 依赖：jq、curl；InsForge 后端已运行且 7130 端口对本机可达（dev 映射 / prod 的 127.0.0.1 绑定）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCS_DIR="$ROOT/functions"

cd "$ROOT/deploy"
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

API_URL="${INSFORGE_URL:-http://localhost:7130}"
API_KEY="${INSFORGE_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "❌ INSFORGE_API_KEY 未设置（见 deploy/.env）" >&2
  exit 1
fi
AUTH="Authorization: Bearer $API_KEY"

deploy_one() {
  local dir="$1"
  local slug; slug="$(basename "$dir")"
  local code_file="$dir/index.js"
  if [ ! -f "$code_file" ]; then
    echo "  ⊘ 跳过 ${slug}（无 index.js）"
    return
  fi

  echo "▶ function: $slug"
  local body
  body=$(jq -n \
    --arg slug "$slug" \
    --arg name "$slug" \
    --arg desc "$slug edge function" \
    --rawfile code "$code_file" \
    '{slug:$slug, name:$name, description:$desc, code:$code, status:"active"}')

  if curl -sf -H "$AUTH" "$API_URL/api/functions/$slug" >/dev/null 2>&1; then
    echo "  · 已存在 → PUT 更新"
    if ! curl -sf -X PUT -H "$AUTH" -H "Content-Type: application/json" \
      -d "$body" "$API_URL/api/functions/$slug" >/dev/null; then
      echo "  ⚠ PUT 失败，尝试查看错误..."
      curl -s -X PUT -H "$AUTH" -H "Content-Type: application/json" \
        -d "$body" "$API_URL/api/functions/$slug" 2>&1 | head -c 200
      return 1
    fi
  else
    echo "  · 新建 → POST 创建"
    if ! curl -sf -X POST -H "$AUTH" -H "Content-Type: application/json" \
      -d "$body" "$API_URL/api/functions" >/dev/null; then
      echo "  ⚠ POST 失败，尝试查看错误..."
      curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
        -d "$body" "$API_URL/api/functions" 2>&1 | head -c 200
      return 1
    fi
  fi
  echo "  ✅ $slug"
  # 每个 function 更新后等待 3 秒，避免触发 API 速率限制（429）
  sleep 3
}

# 部署除 mcp 外的所有 function（mcp 为占位 mock，且 ESM 写法与 OSS CommonJS runtime 冲突）
# 单个 function 失败不退出整个脚本（function 部署为"尽力而为"，失败不阻断前端构建）
failed_count=0
for dir in "$FUNCS_DIR"/*/; do
  [ -d "$dir" ] || continue
  slug="$(basename "$dir")"
  [ "$slug" = "mcp" ] && { echo "⊘ 跳过 mcp（占位，暂不部署）"; continue; }
  if ! deploy_one "$dir"; then
    failed_count=$((failed_count + 1))
    echo "  ⚠ ${slug} 部署失败，跳过继续"
  fi
done
if [ "$failed_count" -gt 0 ]; then
  echo "⚠ ${failed_count} 个 function 部署失败（function 可用 MCP 单独更新，不阻断前端部署）"
fi

# 注入 function secrets（WECOM_* 等）。set_secret 为幂等 upsert：
# POST 新建，已存在（409）则 PUT 覆盖。每次部署都用当前 ENCRYPTION_KEY 把全部 secret
# 重加密一遍 —— 即便历史 key 漂移过、老密文已成孤儿，下次部署自动治愈。
# （根因：secret 解密失败时 deno 运行时会注入空串并覆盖容器 env，把 function 搞崩；
#  保证密文始终可解比"存在则跳过"更安全。）
echo "▶ 注入 function secrets（upsert，用当前 key 重加密）..."
set_secret() {
  local k="$1" v="$2"
  if [ -z "$v" ]; then
    echo "  · $k 未配置，跳过"
    return
  fi
  local body; body=$(jq -n --arg k "$k" --arg v "$v" '{key:$k, value:$v}')
  local code
  code=$(curl -s -o /tmp/insforge_secret_resp -w "%{http_code}" -X POST \
    -H "$AUTH" -H "Content-Type: application/json" \
    -d "$body" "$API_URL/api/secrets")
  case "$code" in
    200|201) echo "  ✅ $k（新建）"; return ;;
    409)
      # 已存在 → PUT 覆盖（用当前 key 重新加密）
      code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT \
        -H "$AUTH" -H "Content-Type: application/json" \
        -d "$body" "$API_URL/api/secrets/$k")
      if [ "$code" = "200" ]; then
        echo "  ✅ $k（PUT 覆盖，重新加密）"
      else
        echo "  ⚠ $k PUT 失败 http=$code"
      fi
      return ;;
    *) echo "  ⚠ $k POST 失败 http=$code: $(head -c 150 /tmp/insforge_secret_resp 2>/dev/null)"; return ;;
  esac
}
set_secret "WECOM_CORP_ID" "${WECOM_CORP_ID:-}"
set_secret "WECOM_SECRET" "${WECOM_SECRET:-}"
set_secret "WECOM_AGENT_ID" "${WECOM_AGENT_ID:-}"
# 企微 App B（同步/通知全员应用，架构文档 §7.1）
set_secret "WECOM_OPS_SECRET" "${WECOM_OPS_SECRET:-}"
set_secret "WECOM_OPS_AGENT_ID" "${WECOM_OPS_AGENT_ID:-}"
set_secret "NOTIFY_DEFAULT_TUSERS" "${NOTIFY_DEFAULT_TUSERS:-}"
# function 内部签 JWT 用（wecom-sync-contacts/webhook 需要 authenticated role 写入）
set_secret "JWT_SECRET" "${JWT_SECRET:-}"
# agent-query 网关签名专用：JWT_SECRET 老 function secret 历史加密损坏（注入空串），
# 故另建 JWT_SIGNING_KEY（值同 JWT_SECRET）。function 优先读它。
set_secret "JWT_SIGNING_KEY" "${JWT_SECRET:-}"
# 智能问数：agent-query 网关鉴权 /query 用（架构文档 §4.2）
set_secret "AGENT_API_KEY" "${AGENT_API_KEY:-}"
# 通讯录变更事件推送（webhook 接收）
set_secret "WECOM_TOKEN" "${WECOM_TOKEN:-}"
set_secret "WECOM_ENCODING_AES_KEY" "${WECOM_ENCODING_AES_KEY:-}"
# function 内部读报表/写审计所需（createClient 调 InsForge API + 推送卡片链接）
set_secret "INSFORGE_BASE_URL" "${INSFORGE_BASE_URL:-http://insforge:7130}"
# 管理 API key（ik_），function 内 createClient/admin 调用备用（当前无固定消费者，保留备用）
set_secret "INSFORGE_API_KEY" "${INSFORGE_API_KEY:-}"
set_secret "ANON_KEY" "${NEXT_PUBLIC_INSFORGE_ANON_KEY:-}"
set_secret "REPORT_URL" "${REPORT_URL:-https://${DOMAIN:-localhost}}"
# Casdoor SSO（wecom-oidc-callback 用；值由 Task 4 Casdoor 应用配置产出，填入 deploy/.env）
set_secret "CASDOOR_ISSUER" "${CASDOOR_ISSUER:-}"
set_secret "CASDOOR_CLIENT_ID" "${CASDOOR_CLIENT_ID:-}"
set_secret "CASDOOR_CLIENT_SECRET" "${CASDOOR_CLIENT_SECRET:-}"

echo "✅ function 部署完成"

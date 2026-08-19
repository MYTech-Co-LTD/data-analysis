#!/usr/bin/env bash
# cleanup-casdoor-legacy.sh —— 2026-08-19 用户裁定：删除新模型（职能|×5 + 范围|×22）之外的全部角色与权限。
# ⚠ 破坏性操作：boss/Small Regional Manager/测试角色上的用户将失去这些角色挂载。
set -uo pipefail
API=https://sso.shanhaiyiguo.com
ORG=shanhai
TOKEN=$(cat /tmp/casdoor_token)
AUTH="Authorization: Bearer $TOKEN"

KEEP_PERMS=("职能|总经理" "职能|财务总" "职能|战区总" "职能|小区经理" "职能|采购负责人" \
  "范围|东部战区" "范围|西部战区" "范围|中部战区" "范围|南部战区" "范围|其他门店" "范围|其余门店1" "范围|广西大区" "范围|贵州宣威大区" \
  "范围|东部一区" "范围|东部二区" "范围|东部三区" "范围|东部四区" "范围|西部一区" "范围|西部二区" \
  "范围|中部一区" "范围|中部二区" "范围|中部三区" "范围|南部一区" "范围|南部二区" "范围|南部三区" "范围|南部四区" "范围|全店")
KEEP_ROLES=("总经理" "财务总" "战区总" "小区经理" "采购负责人" \
  "范围|东部战区" "范围|西部战区" "范围|中部战区" "范围|南部战区" "范围|其他门店" "范围|其余门店1" "范围|广西大区" "范围|贵州宣威大区" \
  "范围|东部一区" "范围|东部二区" "范围|东部三区" "范围|东部四区" "范围|西部一区" "范围|西部二区" \
  "范围|中部一区" "范围|中部二区" "范围|中部三区" "范围|南部一区" "范围|南部二区" "范围|南部三区" "范围|南部四区" "范围|全店")

in_list() {  # $1=value, rest=list
  local v="$1"; shift
  local n
  for n in "$@"; do [ "$n" = "$v" ] && return 0; done
  return 1
}

del_call() {  # $1=endpoint, $2=name
  curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"owner\":\"$ORG\",\"name\":\"$2\"}" "$API/api/$1"
}

fail=0

echo "── 删除多余 permission"
curl -s -H "$AUTH" "$API/api/get-permissions?owner=$ORG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get('data',[]);[print(p['name']) for p in d]" \
  | while IFS= read -r name; do
      [ -z "$name" ] && continue
      if in_list "$name" "${KEEP_PERMS[@]}"; then echo "  ⏭ 保留 permission: $name"; continue; fi
      body=$(del_call delete-permission "$name")
      status=$(echo "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
      if [ "$status" = "ok" ]; then echo "  🗑 permission 删除: $name"; else echo "  ❌ permission 删除失败: $name → $body"; fi
    done

echo "── 删除多余 role"
curl -s -H "$AUTH" "$API/api/get-roles?owner=$ORG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);d=d if isinstance(d,list) else d.get('data',[]);[print(r['name']) for r in d]" \
  | while IFS= read -r name; do
      [ -z "$name" ] && continue
      if in_list "$name" "${KEEP_ROLES[@]}"; then echo "  ⏭ 保留 role: $name"; continue; fi
      body=$(del_call delete-role "$name")
      status=$(echo "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
      if [ "$status" = "ok" ]; then echo "  🗑 role 删除: $name"; else echo "  ❌ role 删除失败: $name → $body"; fi
    done

echo "── 完成"

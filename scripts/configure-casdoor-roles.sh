#!/usr/bin/env bash
# configure-casdoor-roles.sh —— 2026-08-19 用户裁定：角色分两类（职能 / 数据范围）
#   职能角色 5 个：总经理/财务总/战区总/小区经理/采购负责人 → permission 资源=全部能力点（除 *）
#   数据范围角色：每个大区（8 个一级区域）+ 每个小区（14 个二级区域）+ 全店 → permission 资源=范围|X
# 幂等：已存在（同名 role/permission）则跳过；不动现存 permission（含旧"战区总"范围 permission）。
set -uo pipefail
API=https://sso.shanhaiyiguo.com
ORG=shanhai
TOKEN=$(cat /tmp/casdoor_token)
AUTH="Authorization: Bearer $TOKEN"

# 全部能力点（能力页 catalog 单真相，除 *）——组|通俗名，登录时 normalizeFriendlyPerm 归一
CAPS='["品牌|熊喵鲜生","品牌|品品甜","品类|水果","品类|标品","品类|耗材","字段|成本可见","门禁|管理台","门禁|报表中心","看板|指标概览","看板|品牌×指标","看板|门店战区","看板|商品 TOP","看板|类别出库","看板|供应链出库","看板|外部批发","看板|门店零售","看板|门店配送","看板|供应链出库金额","看板|供应链毛利","看板|总配销比","看板|毛利率"]'

FUNC_ROLES=(总经理 财务总 战区总 小区经理 采购负责人)
# 一级区域（大区 8）+ 二级区域（小区 14）+ 全店
SCOPES=(东部战区 西部战区 中部战区 南部战区 其他门店 其余门店1 广西大区 贵州宣威大区 \
        东部一区 东部二区 东部三区 东部四区 西部一区 西部二区 \
        中部一区 中部二区 中部三区 南部一区 南部二区 南部三区 南部四区 全店)

add_role() {  # $1=name
  local exists
  exists=$(curl -s -H "$AUTH" "$API/api/get-role?id=${ORG}/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);print('yes' if (d.get('data') or d.get('name') if isinstance(d,dict) else d) else 'no')" 2>/dev/null)
  if [ "$exists" = "yes" ]; then echo "  ⏭ role 已存在: $1"; return 0; fi
  local body
  body=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"owner\":\"$ORG\",\"name\":\"$1\",\"displayName\":\"$1\",\"isEnabled\":true}" \
    "$API/api/add-role")
  local status
  status=$(echo "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  if [ "$status" = "ok" ]; then echo "  ✅ role 创建: $1"; else echo "  ❌ role 失败: $1 → $body"; return 1; fi
}

add_perm() {  # $1=permission name, $2=role name, $3=resources json array
  local exists
  exists=$(curl -s -H "$AUTH" "$API/api/get-permission?id=${ORG}/$1" | python3 -c "import sys,json;d=json.load(sys.stdin);d=d.get('data') if isinstance(d,dict) and 'data' in d else d;print('yes' if d else 'no')" 2>/dev/null)
  if [ "$exists" = "yes" ]; then echo "  ⏭ permission 已存在: $1"; return 0; fi
  local body
  body=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"owner\":\"$ORG\",\"name\":\"$1\",\"displayName\":\"$1\",\"resourceType\":\"Custom\",\"resources\":$3,\"actions\":[\"Read\"],\"effect\":\"Allow\",\"isEnabled\":true,\"roles\":[\"$ORG/$2\"],\"users\":[]}" \
    "$API/api/add-permission")
  local status
  status=$(echo "$body" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  if [ "$status" = "ok" ]; then echo "  ✅ permission 创建: $1 (role=$2)"; else echo "  ❌ permission 失败: $1 → $body"; return 1; fi
}

fail=0
echo "── 职能角色（5）→ 全能力点 permission"
for r in "${FUNC_ROLES[@]}"; do
  add_role "$r" || fail=1
  add_perm "职能|$r" "$r" "$CAPS" || fail=1
done

echo "── 数据范围角色（${#SCOPES[@]}）→ 范围|X permission"
for s in "${SCOPES[@]}"; do
  add_role "范围|$s" || fail=1
  add_perm "范围|$s" "范围|$s" "[\"范围|$s\"]" || fail=1
done

echo "── 完成 (fail=$fail)"
exit $fail

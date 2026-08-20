#!/usr/bin/env bash
# assign-roles-2026-08-19.sh —— 小区负责人表_2026-08-18.xlsx 落地角色挂载
#   大区负责人 → 战区总 + 范围|<大区>；小区负责人 → 小区经理 + 范围|<小区>（刘合法双职合并）
# 形态（真机验证款）：get-user?id= 解包 → merge roles（只增不删）→ update-user?id=owner/name
set -uo pipefail
API=https://sso.shanhaiyiguo.com
ORG=shanhai
TOKEN=$(cat /tmp/casdoor_token)
AUTH="Authorization: Bearer $TOKEN"

# casdoor用户名|角色（逗号分隔，组织前缀内）
ASSIGN=(
  "ShanHaiYiGuoDaXiong|战区总,范围|东部战区"                # 王松
  "LiuHeFa|战区总,范围|南部战区,小区经理,范围|南部四区"      # 刘合法（大区+小区双职）
  "DongZeHu|战区总,范围|西部战区"                           # 董泽虎
  "ZhengXin|小区经理,范围|中部一区,范围|中部三区"            # 郑欣（两区）
  "XunZhiQuan|小区经理,范围|中部二区"                       # 荀智权
  "ShanHaiYiGuoChenGe|小区经理,范围|东部一区"               # 唐凌晨
  "LiuYouZe|小区经理,范围|东部二区"                         # 刘友泽
  "HaiDaoDeFeng|小区经理,范围|东部三区,范围|东部四区"        # 张琳（两区）
  "PengJinBo|小区经理,范围|南部一区"                        # 彭进博
  "l|小区经理,范围|南部二区"                                # 李俊苇
  "DongPingXia|小区经理,范围|南部三区"                      # 董平霞
  "DuanQingHai|小区经理,范围|西部一区"                      # 段清海
  "WuXianChen|小区经理,范围|西部二区"                       # 业海滨
  "HuangGuoXiong|小区经理,范围|西部二区"                    # 黄国雄
)
# 未建户（首登 JIT 后补挂）：施媛媛(战区总+范围|中部战区)、王潇(小区经理+范围|中部三区)、
#   禹顺斌(小区经理+范围|东部一区)、武子涵(小区经理+范围|西部一区)

fail=0
for entry in "${ASSIGN[@]}"; do
  user="${entry%%|*}"
  roles_csv="${entry#*|}"
  python3 - "$user" "$roles_csv" <<'PYEOF'
import sys, json, urllib.request

user, roles_csv = sys.argv[1], sys.argv[2]
ORG = "shanhai"
TOKEN = open("/tmp/casdoor_token").read().strip()
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
API = "https://sso.shanhaiyiguo.com"

def call(method, path, body=None):
    req = urllib.request.Request(f"{API}{path}", method=method, headers=H,
                                 data=json.dumps(body).encode() if body else None)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

# get-user?id= 解包（T6 真机形态：data 才是用户对象）
d = call("GET", f"/api/get-user?id={ORG}/{urllib.parse.quote(user)}")
u = d.get("data") or (d if d.get("name") else None)
if not u:
    print(f"  ❌ {user}: 用户不存在"); sys.exit(1)

current = [r if isinstance(r, str) else r.get("name") for r in (u.get("roles") or [])]
current = [f"{ORG}/{r}" if "/" not in str(r) else str(r) for r in current]
want = [f"{ORG}/{r}" for r in roles_csv.split(",")]
missing = [r for r in want if r not in current]
if not missing:
    print(f"  ⏭ {user}（{u.get('displayName')}）角色已齐: {roles_csv}"); sys.exit(0)

# roles 需对象形态（object.Role，真机报错 cannot unmarshal string）
role_objs = [{"owner": ORG, "name": r.split("/", 1)[1]} for r in current] + \
            [{"owner": ORG, "name": r.split("/", 1)[1]} for r in missing]
res = call("POST", f"/api/update-user?id={ORG}/{urllib.parse.quote(user)}",
           {**u, "roles": role_objs})
if res.get("status") == "ok":
    print(f"  ✅ {user}（{u.get('displayName')}）+ {','.join(m.split('/',1)[1] for m in missing)}")
else:
    print(f"  ❌ {user}: {res}"); sys.exit(1)
PYEOF
  [ $? -ne 0 ] && fail=1
done
echo "── 完成 (fail=$fail)"
exit $fail

#!/usr/bin/env bash
# assign-roles-2026-08-19-v2.sh —— 从 role 侧挂 users（Casdoor 绑定真相在 role.users；update-user 的 roles 字段不落库）
#   大区负责人 → 战区总 + 范围|<大区>；小区负责人 → 小区经理 + 范围|<小区>
set -uo pipefail
python3 <<'PYEOF'
import json, urllib.request, urllib.parse

ORG = "shanhai"
TOKEN = open("/tmp/casdoor_token").read().strip()
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
API = "https://sso.shanhaiyiguo.com"

def call(method, path, body=None):
    req = urllib.request.Request(f"{API}{path}", method=method, headers=H,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.load(r)

# displayName → casdoor username（已存在用户）
NAME = {
    "王松": "ShanHaiYiGuoDaXiong", "刘合法": "LiuHeFa", "董泽虎": "DongZeHu",
    "郑欣": "ZhengXin", "荀智权": "XunZhiQuan", "唐凌晨": "ShanHaiYiGuoChenGe",
    "刘友泽": "LiuYouZe", "张琳": "HaiDaoDeFeng", "彭进博": "PengJinBo",
    "李俊苇": "l", "董平霞": "DongPingXia", "段清海": "DuanQingHai",
    "业海滨": "WuXianChen", "黄国雄": "HuangGuoXiong",
}
# 角色 → 人员（display 名）
ROLE_USERS = {
    "战区总": ["王松", "刘合法", "董泽虎"],                       # 施媛媛未建户
    "范围|东部战区": ["王松"], "范围|南部战区": ["刘合法"], "范围|西部战区": ["董泽虎"],
    "小区经理": ["郑欣", "荀智权", "唐凌晨", "刘友泽", "张琳", "彭进博", "李俊苇",
                "董平霞", "段清海", "业海滨", "黄国雄", "刘合法"],
    "范围|中部一区": ["郑欣"], "范围|中部三区": ["郑欣"],
    "范围|中部二区": ["荀智权"],
    "范围|东部一区": ["唐凌晨"], "范围|东部二区": ["刘友泽"],
    "范围|东部三区": ["张琳"], "范围|东部四区": ["张琳"],
    "范围|南部一区": ["彭进博"], "范围|南部二区": ["李俊苇"],
    "范围|南部三区": ["董平霞"], "范围|南部四区": ["刘合法"],
    "范围|西部一区": ["段清海"], "范围|西部二区": ["业海滨", "黄国雄"],
}

fail = 0
for role_name, people in ROLE_USERS.items():
    d = call("GET", f"/api/get-role?id={ORG}/{urllib.parse.quote(role_name)}")
    role = d.get("data") or (d if d.get("name") else None)
    if not role:
        print(f"  ❌ role 不存在: {role_name}"); fail = 1; continue
    current = [u for u in (role.get("users") or []) if isinstance(u, str)]
    want = [f"{ORG}/{NAME[p]}" for p in people if p in NAME]
    missing = [w for w in want if w not in current]
    if not missing:
        print(f"  ⏭ {role_name}: users 已齐"); continue
    res = call("POST", f"/api/update-role?id={ORG}/{urllib.parse.quote(role_name)}",
               {**role, "users": current + missing})
    if res.get("status") == "ok":
        print(f"  ✅ {role_name} + {', '.join(m.split('/',1)[1] for m in missing)}")
    else:
        print(f"  ❌ {role_name}: {res.get('msg') or res}"); fail = 1

print(f"完成 fail={fail}")
exit(fail)
PYEOF

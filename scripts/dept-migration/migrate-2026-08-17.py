#!/usr/bin/env python3
# 企微部门组树迁移（2026-08-17，用户裁定：组织架构严格按企微）
# DRY=1 时只做校验与计划输出，不写 Casdoor。
import json, subprocess, sys, os

DRY = os.environ.get('DRY') == '1'
TOKEN = open('/tmp/cd_newtok').read().strip()
SSH = 'ssh -i ~/.ssh/ShanHai-OPS.pem -o ConnectTimeout=20 root@data.shanhaiyiguo.com'
ORG = 'shanhai'
APP = 'data-analysis'
FORBIDDEN = set('/?:#&%=+;')

def api(path, method='GET', body=None):
    req = subprocess.run(
        ['curl', '-s', '-m', '30', '-X', method,
         '-H', f'Authorization: Bearer {TOKEN}', '-H', 'Content-Type: application/json',
         *(['-d', json.dumps(body, ensure_ascii=False)] if body is not None else []),
         'https://sso.shanhaiyiguo.com' + path],
        capture_output=True, text=True)
    try:
        return json.loads(req.stdout)
    except Exception:
        return {'status': 'parse_error', 'raw': req.stdout[:200]}

def psql_json(sql):
    out = subprocess.run(
        SSH + ' "docker exec deploy-postgres-1 psql -U postgres -d insforge -tA -c \\"' + sql + '\\""',
        shell=True, capture_output=True, text=True)
    return [json.loads(l) for l in out.stdout.strip().split('\n') if l]

# ---- A. 源数据（row_to_json 输出，规避 SSH 层双引号转义）----
depts = psql_json("SELECT row_to_json(d) FROM (SELECT id::text AS id, name, coalesce(parent_id::text,'') AS parent FROM org_departments WHERE is_active ORDER BY id) d")
users = psql_json("SELECT row_to_json(u) FROM (SELECT wecom_id, coalesce(name,wecom_id) AS name, coalesce(department_ids::text,'[]') AS deps, role_id::text AS role FROM org_users WHERE is_active ORDER BY wecom_id) u")
print(f'源：部门 {len(depts)}，活跃用户 {len(users)}')

dept_by_id = {d['id']: d for d in depts}
name_by_id = {d['id']: d['name'] for d in depts}
errors = []

# 校验：部门名唯一
names = [d['name'] for d in depts]
dup = {n for n in names if names.count(n) > 1}
if dup: errors.append(f'部门重名: {dup}')
# 校验：禁字符
bad = [d['name'] for d in depts if set(d['name']) & FORBIDDEN]
if bad: errors.append(f'部门名含禁字符: {bad}')
# 校验：父子存在性
for d in depts:
    if d['parent'] and d['parent'] not in dept_by_id: errors.append(f'部门 {d["name"]}({d["id"]}) 父 {d["parent"]} 不存在')
# 校验：用户 department_ids 可解析
orphan = []
for u in users:
    for dep in json.loads(u['deps']):
        if dep not in name_by_id: orphan.append((u['wecom_id'], dep))
if orphan: errors.append(f'用户挂不存在部门: {orphan}')
if errors:
    print('❌ 校验失败:'); [print(' ', e) for e in errors]; sys.exit(1)
print('✅ 校验通过（部门名唯一/无禁字符/父链完整/用户部门全可解析）')

# ---- B. 组树（拓扑序：父先于子）----
def topo(depts):
    by_parent, done, out = {}, set(), []
    for d in depts: by_parent.setdefault(d['parent'] or '', []).append(d)
    def visit(key):
        for d in by_parent.get(key, []):
            out.append(d); done.add(d['id']); visit(d['id'])
    visit('')
    for d in depts:
        if d['id'] not in done: out.append(d); done.add(d['id'])
    return out

ordered = topo(depts)
existing_groups = {g.get('name') for g in (api(f'/api/get-groups?owner={ORG}').get('data') or [])}
print(f'Casdoor 现有组 {len(existing_groups)}（含旧门店树）')

to_create = []
for d in ordered:
    if d['name'] in existing_groups: continue
    parent_name = name_by_id.get(d['parent'], '') if d['parent'] else ''
    body = {
        'owner': ORG, 'name': d['name'], 'displayName': d['name'], 'type': 'Virtual',
        'parentId': parent_name if parent_name else ORG,   # 根（无父）→ anchor 'shanhai'（E7 已验证形态）
        'isTopGroup': not bool(parent_name),
        'properties': {'createdBy': 'wecom-dept-migration', 'groupType': 'dept'},   # 须对象非字符串（API map[string]string）
        'isEnabled': True,
    }
    to_create.append(body)
print(f'待建组 {len(to_create)}：' + '、'.join(b["name"] for b in to_create))

# ---- C. 用户挂组计划 ----
existing_users = {u.get('name'): u for u in (api(f'/api/get-users?owner={ORG}').get('data') or [])}
plan_create, plan_update = [], []
import re
WS_RE = re.compile(r'^[a-zA-Z0-9_-]+$')
invalid_ids = [u['wecom_id'] for u in users if not WS_RE.match(u['wecom_id'])]
if invalid_ids: print(f'⚠️ wecom_id 不合 Casdoor 用户名规则（跳过，需人工处理）: {invalid_ids}')
users = [u for u in users if WS_RE.match(u['wecom_id'])]
for u in users:
    deps = json.loads(u['deps'])
    groups = [f'{ORG}/{name_by_id[d]}' for d in deps if d in name_by_id]
    if not groups: groups = [f'{ORG}/山海一果']   # 无部门 → 根组（非战区链=全店口径）
    groups = sorted(set(groups))
    if u['wecom_id'] not in existing_users:
        plan_create.append({'owner': ORG, 'name': u['wecom_id'], 'displayName': u['name'], 'email': '', 'phone': '',
                            'groups': groups, 'signupApplication': APP, 'type': 'normal-user'})
    else:
        cur = sorted(set(existing_users[u['wecom_id']].get('groups') or []))
        if cur != groups: plan_update.append((u['wecom_id'], cur, groups))
print(f'待建户 {len(plan_create)}，待改挂组 {len(plan_update)}')
for w, cur, new in plan_update: print(f'  改挂 {w}: {cur} → {new}')

if DRY:
    print('DRY RUN 结束，未写入。'); sys.exit(0)

# ---- D. 执行 ----
fails = []
for b in to_create:
    r = api('/api/add-group', 'POST', b)
    if r.get('status') != 'ok': fails.append(('group', b['name'], r))
for b in plan_create:
    r = api('/api/add-user', 'POST', b)
    if r.get('status') != 'ok': fails.append(('user', b['name'], r))
for w, _cur, new in plan_update:
    u = existing_users[w]
    u['groups'] = new
    r = api(f'/api/update-user?id={ORG}/{w}', 'POST', u)
    if r.get('status') != 'ok': fails.append(('update', w, r))

print(f'执行完成：建组 {len(to_create)} 建户 {len(plan_create)} 改挂 {len(plan_update)}，失败 {len(fails)}')
for f in fails: print('  ❌', f[0], f[1], str(f[2])[:150])

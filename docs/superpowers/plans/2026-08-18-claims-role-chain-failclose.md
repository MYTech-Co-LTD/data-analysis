# 消费侧 fail-close：claims 只认角色链 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录时 claims 只认角色链（permission.roles 命中用户角色），`permission.users` 直挂与 `permission.groups` 挂载一律不产生作用，实现三层模型强制。

**Architecture:** 把 `functions/wecom-oidc-callback/index.js` 的可达对象取数从 `GET /api/get-all-objects?userId=`（并集，含直挂）替换为 `GET /api/get-permissions?owner=` + 角色链过滤（只取 `permission.roles` 命中用户角色码的 `resources` 并集）。取数匹配逻辑抽成纯函数 `matchRolePermissions` 放 `claims.js` 供契约测试。下游（normalizeFriendlyPerm / 门店范围展开 / buildClaims / RLS）零改动。

**Tech Stack:** Node.js（CommonJS，InsForge runtime）+ Casdoor REST API + esbuild bundle。测试为手写断言（Deno/node 双跑，零依赖）。

## Global Constraints

- 只改 `functions/wecom-oidc-callback/`（function-only 部署，SSH 直调 InsForge API PUT + 清 Deno 缓存，**不触发 GHA**）——CLAUDE.md 部署决策规则
- `claims.js` 是 CommonJS（`module.exports`），禁 ESM import/export（function.json runtime=commonjs）
- `index.js` 运行时禁 ESM；InsForge OSS runtime 用 CommonJS + 全局注入（createClient、Deno）
- `reachable` 输出形态不变（string[]），下游 `buildClaims`/门店展开零改动
- fail-close 语义：取数失败 → `null` → C2 503；用户无角色 → 空数组 → B1 空集 = deny（不 fail 登录）
- `isEnabled` 不滤（与 get-all-objects 原语义一致，测试权限 isEnabled=False 改挂角色后照样生效）
- 匹配归一：userinfo roles claim 是裸名（`manager`），permission.roles 是全路径（`shanhai/manager`）→ 匹配时 `split('/').pop()` 归一
- spec：`docs/superpowers/specs/2026-08-18-claims-role-chain-failclose-design.md`；架构文档 `docs/architecture.md` §6.1 已更新

---

### Task 1: claims.js 新增 `matchRolePermissions` 纯函数 + 契约测试

**Files:**
- Modify: `functions/wecom-oidc-callback/claims.js`（文件末尾 module.exports 前加函数；导出行追加）
- Modify: `functions/wecom-oidc-callback/claims.test.js`（文件末尾追加断言段）
- Test: `cd functions/wecom-oidc-callback && (deno test claims.test.js 2>/dev/null || node claims.test.js)`

**Interfaces:**
- Produces: `matchRolePermissions(perms, myRoleCodes) => string[]`
  - `perms`: get-permissions 返回的 permission 数组（每项含 `roles?: string[]`、`resources?: string[]`）
  - `myRoleCodes`: 用户角色码数组（裸名，如 `['manager']`）
  - 返回：命中任一角色的 permission 的 `resources` 并集（去重）。直挂（`roles=[]`）与 groups 挂载天然排除。null/undefined 入参 → 空数组。

- [ ] **Step 1: 在 claims.js 加纯函数**

在 `collapseFullStore` 函数之后、文件末尾 `module.exports` 之前插入：

```js
// 角色链匹配（2026-08-18 三层模型强制）：只取 permission.roles 命中用户角色码的 permission resources 并集。
//   permission.users 直挂（roles=[]）与 permission.groups 挂载天然匹配不上 → 排除（任何来源写入直挂都不生效）。
//   roles 全路径（'shanhai/manager'）vs 用户角色码裸名（'manager'）→ split('/').pop() 归一。
//   纯函数，无 I/O —— claims.test.js 契约断言防回归；index.js fetchRolePermissions 复用。
function matchRolePermissions(perms, myRoleCodes) {
  const mine = new Set((myRoleCodes ?? []).map((r) => String(r)));
  const out = new Set();
  for (const p of perms ?? []) {
    const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
    const hit = pr.some((r) => mine.has(r) || mine.has(String(r).split('/').pop()));
    if (!hit) continue;
    for (const res of p.resources ?? []) if (typeof res === 'string') out.add(res);
  }
  return [...out];
}
```

- [ ] **Step 2: 导出 matchRolePermissions**

把文件末尾两个 `module.exports` 行的第二个（line 126）改为：

```js
module.exports = { buildClaims, collapseFullStore, resolveGroupBranches, resolveScopeKeys, FRIENDLY_TO_KEY, normalizeFriendlyPerm, BOARD_VIEW_COVERAGE, matchRolePermissions };
```

- [ ] **Step 3: 在 claims.test.js 文件末尾追加契约断言段**

```js
// ============ matchRolePermissions（三层模型强制，2026-08-18）============
const { matchRolePermissions } = require('./claims.js');

// Casdoor permission 真实形态：roles=全路径数组；直挂用户存 users（本函数不读）；groups 挂载存 groups（本函数不读）
const permsRole = [
  { name: 'role-manager', roles: ['shanhai/manager'], users: [], resources: ['data-analysis:view:reports', 'push:broadcast'] },
  { name: 'role-boss', roles: ['shanhai/boss'], users: [], resources: ['data-analysis:admin'] },
];
const permsDirect = [
  { name: 'scope-张三', roles: [], users: ['shanhai/张三'], resources: ['data-analysis:branch:*'] },
];
const permsMixed = [
  { name: 'role-zone', roles: ['shanhai/zone_manager'], users: ['shanhai/郑欣'], resources: ['data-analysis:view-board:region'] },
];

eq(matchRolePermissions(permsRole, ['manager']), ['data-analysis:view:reports', 'push:broadcast'], '角色命中（用户裸名 vs 权限全路径）→ resources 并集');
eq(matchRolePermissions(permsRole, ['boss']), ['data-analysis:admin'], '只取命中角色的 permission');
eq(matchRolePermissions([...permsRole, ...permsDirect], ['manager']), ['data-analysis:view:reports', 'push:broadcast'], '直挂（roles=[]）被排除——三层模型强制');
eq(matchRolePermissions([...permsRole, ...permsMixed], ['manager', 'zone_manager']),
  ['data-analysis:view:reports', 'push:broadcast', 'data-analysis:view-board:region'], '多角色 UNION；混合形态角色命中即取全部 resources');
eq(matchRolePermissions([...permsRole, ...permsMixed], ['zone_manager']), ['data-analysis:view-board:region'], '只命中一个角色的资源');
eq(matchRolePermissions(permsDirect, ['张三']), [], '用户角色码存在但权限全是直挂 → 空集（B1 deny 载体）');
eq(matchRolePermissions([], ['manager']), [], '全量空 → 空数组');
eq(matchRolePermissions(permsRole, []), [], '无角色 → 空数组（无角色即无授权）');
eq(matchRolePermissions(undefined, ['manager']), [], 'undefined 入参防御 → 空数组');

console.log('matchRolePermissions assertions passed');
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd functions/wecom-oidc-callback && node claims.test.js`
Expected: 末尾输出 `matchRolePermissions assertions passed`，无 ✗

- [ ] **Step 5: Commit**

```bash
git add functions/wecom-oidc-callback/claims.js functions/wecom-oidc-callback/claims.test.js
git commit -m "feat: claims 角色链匹配纯函数 matchRolePermissions + 契约测试（三层模型强制）"
```

---

### Task 2: index.js 取数替换 fetchAllObjects → fetchRolePermissions

**Files:**
- Modify: `functions/wecom-oidc-callback/index.js`（line 26 import、line 45-68 fetchAllObjects、line 308-313 调用点）
- Modify: `functions/wecom-oidc-callback/index.bundle.js`（重新生成，服务器无 npx 回退产物）
- Test: `bash scripts/check-functions.sh`

**Interfaces:**
- Consumes: `matchRolePermissions(perms, myRoleCodes)`（Task 1 产出）
- Produces: `fetchRolePermissions(issuer, accessToken, owner, roleCodes) => string[] | null`
  - 失败/非数组 → `null`（C2 fail-close）；成功 → resources 并集 string[]（空集合法，B1 deny 载体）

- [ ] **Step 1: 更新 import 行（line 26）**

把：
```js
const { buildClaims, collapseFullStore, resolveGroupBranches, resolveScopeKeys, normalizeFriendlyPerm } = require("./claims");
```
改为：
```js
const { buildClaims, collapseFullStore, resolveGroupBranches, resolveScopeKeys, normalizeFriendlyPerm, matchRolePermissions } = require("./claims");
```

- [ ] **Step 2: 用 fetchRolePermissions 替换 fetchAllObjects（line 45-68）**

把整个 `fetchAllObjects` 函数（含上方注释行 45-49）替换为：

```js
// ②' 角色链可达对象（2026-08-18 三层模型强制）：只取 permission.roles 命中用户角色码的 permission resources。
//    get-permissions?owner= 全量（每项含 roles/users/groups/resources）；permission.users 直挂（roles=[]）
//    与 permission.groups 挂载天然匹配不上 → 排除——不管直挂从 Casdoor UI / API / 脚本写入都不生效。
//    输入 owner = token owner claim（'shanhai'），roleCodes = 登录时 userinfo roles claim（裸名，index.js 2b 提取）。
//    失败/非数组 → null（由 buildClaims 判 C2 → 503）；空集（有角色但权限 roles 全不命中）→ []（B1 deny 载体）。
async function fetchRolePermissions(issuer, accessToken, owner, roleCodes) {
  try {
    const res = await fetch(`${issuer}/api/get-permissions?owner=${encodeURIComponent(owner)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      console.error("wecom-oidc-callback: get-permissions http", res.status,
        (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const data = await res.json();
    const perms = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
    if (!perms) return null;
    return matchRolePermissions(perms, roleCodes);
  } catch (e) {
    console.error("wecom-oidc-callback: get-permissions failed", e);
    return null;
  }
}
```

- [ ] **Step 3: 更新调用点（line 308-313）**

把：
```js
    // ② get-all-objects 可达对象（F11）
    // 不能直传 sub：该 API 要求 owner/name 双段，sub 是裸 user.Id → wrong token count → data=null → 503
    const casdoorUserId = tokenPayload.owner && tokenPayload.name
      ? `${tokenPayload.owner}/${tokenPayload.name}`
      : tokenPayload.sub;
    const reachable = await fetchAllObjects(issuer, accessToken, casdoorUserId);
```
改为：
```js
    // ②' 角色链可达对象（2026-08-18 三层模型强制）：只认 permission.roles 命中用户角色码的资源。
    //    owner 取 token owner claim（构造双段 userId 的同源）；roleCodes = userinfo roles claim（2b 已提取）。
    const casdoorOwner = tokenPayload.owner || "shanhai";
    const reachable = await fetchRolePermissions(issuer, accessToken, casdoorOwner, casdoorRoles);
```

- [ ] **Step 4: 更新文件头注释（line 15）**

把 `//   ② get-all-objects 可达对象（policy 侧，F11——与 get-resources 注册表语义区分）` 改为：
`//   ② get-permissions 角色链可达对象（2026-08-18 三层模型强制：只认 permission.roles 命中用户角色的 resources，直挂/groups 挂载排除）`

- [ ] **Step 5: 重新生成 index.bundle.js（服务器无 npx 回退产物）**

Run:
```bash
cd functions/wecom-oidc-callback && npx --yes esbuild index.js --bundle --format=cjs --log-level=warning --outfile=index.bundle.js
```
Expected: 无报错，index.bundle.js 更新

- [ ] **Step 6: 校验 + 测试**

Run: `bash scripts/check-functions.sh 2>&1 | grep -A2 "wecom-oidc-callback"`
Expected: `✅ wecom-oidc-callback` 且 `现场 bundle 合法单文件 CJS`、`index.bundle.js 语法合法`
Run: `cd functions/wecom-oidc-callback && node claims.test.js`
Expected: 全部 ✓（含 matchRolePermissions 段）

- [ ] **Step 7: Commit**

```bash
git add functions/wecom-oidc-callback/index.js functions/wecom-oidc-callback/index.bundle.js
git commit -m "feat: 登录取数改角色链（get-permissions 匹配），直挂不再生效（三层模型强制，消费侧 fail-close）"
```

---

### Task 3: 存量数据清理脚本 `scripts/enforce-role-chain.mjs`

**Files:**
- Create: `scripts/enforce-role-chain.mjs`

**Interfaces:**
- Produces: CLI（dry-run 默认，`--apply` 写 Casdoor）。env：`CASDOOR_API_URL`/`CASDOOR_API`（缺省 https://sso.shanhaiyiguo.com）、`CASDOOR_CLIENT_ID`、`CASDOOR_CLIENT_SECRET`、`CASDOOR_ORG`（缺省 shanhai）
- 输出报表逐行打勾/打叉，`--apply` 后 diff 非零 exit 1

- [ ] **Step 1: 写脚本（幂等，dry-run 默认）**

创建 `scripts/enforce-role-chain.mjs`：

```js
#!/usr/bin/env node
// scripts/enforce-role-chain.mjs
// 2026-08-18 三层模型存量清理（一次性，幂等，dry-run 默认）：
//   1. 建 test-role 角色（若不存在；承载测试权限）
//   2. 「测试」「测试02」permission：roles=['shanhai/test-role']、users=[]（清直挂）
//   3. test-role.users = 原测试权限直挂用户并集（ZhangDuo, YangWei）
//   4. role-zone_manager：users=[]（清 ZhengXin 直挂，他仍走 zone_manager 角色，授权不变）
// 用法：node scripts/enforce-role-chain.mjs            # dry-run：只出报表
//       node scripts/enforce-role-chain.mjs --apply    # 写 Casdoor
// env：CASDOOR_CLIENT_ID/SECRET（client_credentials）
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

const CASDOOR_API = process.env.CASDOOR_API_URL || process.env.CASDOOR_API || 'https://sso.shanhaiyiguo.com';
const CASDOOR_CLIENT_ID = process.env.CASDOOR_CLIENT_ID || '';
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET || '';
const CASDOOR_ORG = process.env.CASDOOR_ORG || 'shanhai';

if (!CASDOOR_CLIENT_ID || !CASDOOR_CLIENT_SECRET) {
  console.error('❌ 缺 env：CASDOOR_CLIENT_ID / CASDOOR_CLIENT_SECRET');
  process.exit(2);
}

async function casdoor(token, path, method = 'GET', body) {
  const resp = await fetch(`${CASDOOR_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let j; try { j = JSON.parse(text); } catch { j = null; }
  if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status} ${text.slice(0, 200)}`);
  return j;
}

const tok = await casdoor(null, '/api/login/oauth/access_token', 'POST', {
  grant_type: 'client_credentials', client_id: CASDOOR_CLIENT_ID,
  client_secret: CASDOOR_CLIENT_SECRET, scope: 'openid',
});
const token = tok.access_token;
if (!token) { console.error('❌ no access_token'); process.exit(2); }

// 全量 roles / permissions
const rolesBody = await casdoor(token, `/api/get-roles?owner=${encodeURIComponent(CASDOOR_ORG)}`);
const roles = Array.isArray(rolesBody) ? rolesBody : (rolesBody.data ?? []);
const permBody = await casdoor(token, `/api/get-permissions?owner=${encodeURIComponent(CASDOOR_ORG)}`);
const perms = Array.isArray(permBody) ? permBody : (permBody.data ?? []);
const getRole = (name) => roles.find((r) => r.name === name);

const report = [];
const roleFull = (name) => `${CASDOOR_ORG}/${name}`;

// ── 1. 建 test-role（若不存在）──
let testRole = getRole('test-role');
if (!testRole) {
  if (APPLY) {
    await casdoor(token, '/api/add-role', 'POST', {
      owner: CASDOOR_ORG, name: 'test-role', displayName: '测试角色',
      users: [], roles: [], isEnabled: true,
    });
    testRole = { name: 'test-role', users: [] };
  }
  report.push({ action: 'CREATE test-role', ok: APPLY, detail: APPLY ? '' : '（dry-run）' });
} else {
  report.push({ action: 'test-role 已存在', ok: true, detail: `users=${(testRole.users ?? []).length}` });
}

// ── 2/3. 测试权限：roles=[test-role]、清 users；直挂用户并入 test-role ──
const testPermNames = ['测试', '测试02'];
for (const pname of testPermNames) {
  const p = perms.find((x) => x.name === pname);
  if (!p) { report.push({ action: `permission ${pname}`, ok: false, detail: '不存在（跳过）' }); continue; }
  const directUsers = Array.isArray(p.users) ? p.users : [];
  const hasRole = (p.roles ?? []).map((r) => String(r)).includes(roleFull('test-role'));
  if (APPLY && (!hasRole || directUsers.length > 0)) {
    const nextUsers = APPLY ? [] : p.users;
    await casdoor(token, `/api/update-permission?id=${encodeURIComponent(`${CASDOOR_ORG}/${pname}`)}`, 'POST', {
      owner: CASDOOR_ORG, name: pname, displayName: p.displayName ?? pname,
      users: nextUsers, roles: [roleFull('test-role')], groups: p.groups ?? [],
      resources: p.resources ?? [], actions: p.actions ?? ['Read'],
      effect: p.effect ?? 'Allow', isEnabled: p.isEnabled ?? false,
    });
  }
  report.push({ action: `permission ${pname}`, ok: true, detail: `roles→[test-role]，users 清直挂（${directUsers.length} 人）` });
  for (const u of directUsers) {
    const bare = String(u).split('/').pop();
    report.push({ action: `  直挂用户 ${bare} → test-role`, ok: APPLY, detail: APPLY ? '' : '（dry-run）' });
  }
}

// test-role.users = 测试权限直挂用户并集
const testDirectUsers = [...new Set(perms
  .filter((p) => testPermNames.includes(p.name))
  .flatMap((p) => (Array.isArray(p.users) ? p.users : []))
  .map((u) => String(u)))];
if (APPLY && testDirectUsers.length > 0 && testRole) {
  const cur = Array.isArray(testRole.users) ? testRole.users.map((u) => String(u)) : [];
  const next = [...new Set([...cur, ...testDirectUsers])];
  await casdoor(token, `/api/update-role?id=${encodeURIComponent(roleFull('test-role'))}`, 'POST', {
    owner: CASDOOR_ORG, name: 'test-role', displayName: '测试角色', users: next, isEnabled: true,
  });
}

// ── 4. role-zone_manager：清 users（ZhengXin 直挂）──
const zm = getRole('zone_manager');
if (zm && (zm.users ?? []).length > 0) {
  const n = (zm.users ?? []).length;
  if (APPLY) {
    await casdoor(token, `/api/update-role?id=${encodeURIComponent(roleFull('zone_manager'))}`, 'POST', {
      owner: CASDOOR_ORG, name: 'zone_manager', displayName: zm.displayName ?? '', users: [], isEnabled: true,
    });
  }
  report.push({ action: 'role-zone_manager 清直挂 users', ok: APPLY, detail: `${n} 人（郑欣仍走 zone_manager 角色，授权不变）` });
} else {
  report.push({ action: 'role-zone_manager', ok: true, detail: '无直挂 users' });
}

// ── 报表 ──
console.log(`\n===== 三层模型存量清理（${APPLY ? 'APPLY' : 'DRY-RUN'}）=====`);
let fail = 0;
for (const r of report) {
  const mark = r.ok ? '✅' : '⚠️';
  if (!r.ok) fail++;
  console.log(`${mark} ${r.action} ${r.detail}`);
}
if (fail > 0) { console.error(`\n❌ ${fail} 项异常`); process.exit(1); }
console.log('\n✅ 完成');
```

- [ ] **Step 2: 本机 dry-run 核对报表（先不 apply）**

Run:
```bash
cd scripts && DATABASE_URL= node enforce-role-chain.mjs
```
Expected: 报表列出「CREATE test-role（dry-run）」「测试/测试02 → roles→[test-role]」「zone_manager 清直挂（1 人）」等，无 ⚠️

> 注：脚本不连 DB（无 DATABASE_URL 依赖）；上述命令仅验证脚本 dry-run 能完整跑到报表输出。若本机无 CASDOOR env，可在生产服务器 source .env 后跑（Task 4）。

- [ ] **Step 3: Commit**

```bash
git add scripts/enforce-role-chain.mjs
git commit -m "feat: 三层模型存量清理脚本 enforce-role-chain（建 test-role、测试权限改挂角色、清郑欣双挂，dry-run 默认）"
```

---

### Task 4: 生产数据清理 + 部署 function + 验证

**Files:**
- 无代码改动（生产运维）

- [ ] **Step 1: 生产跑数据清理 apply**

先 scp 脚本上服务器（function-only 部署不触发 GHA rsync，脚本不会自动到达）：
```bash
scp -i "~/.ssh/ShanHai-OPS.pem" scripts/enforce-role-chain.mjs root@data.shanhaiyiguo.com:/opt/data-analytics-platform/scripts/
```
再在服务器 source .env 后跑 apply：
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a && . ./.env && set +a && cd /opt/data-analytics-platform && CASDOOR_API_URL=https://sso.shanhaiyiguo.com CASDOOR_CLIENT_ID="$CASDOOR_CLIENT_ID" CASDOOR_CLIENT_SECRET="$CASDOOR_CLIENT_SECRET" node scripts/enforce-role-chain.mjs --apply'
```
Expected: 全 ✅。随后复核：
```bash
# 确认 7 permission 形态：5 role-* roles 命中、测试/测试02 roles=[test-role] users=[]、zone_manager users=[]
```

- [ ] **Step 2: 生产部署 function（SSH 直调 PUT，不触发 GHA）**

Run（单 function PUT，同 deploy-functions.sh 的 deploy_one）:
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
body=$(jq -n --arg slug "wecom-oidc-callback" --arg name "wecom-oidc-callback" --arg desc "wecom-oidc-callback" --rawfile code "$PWD/../functions/wecom-oidc-callback/index.bundle.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/wecom-oidc-callback'
```

- [ ] **Step 3: 清 Deno 缓存使更新生效**

Run:
```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 4: 生产验证——登录后 decode JWT claims**

对 ZhangDuo（测试角色）、YangWei（测试角色）、郑欣（zone_manager）、一个普通 manager 用户（如任一下游）各测一次登录（走企微回调 code 流程，或复用已有 access_token 重放），然后校验：
1. 登录返回的 `access_token` 的 JWT payload（base64 decode 中间段）里：
   - `permissions` 含角色链带来的能力资源（如 `data-analysis:view:reports` 等）
   - **不含**任何仅来自直挂的资源（本次改造后直挂已清零，故重点核对「测试角色资源确实生效」）
2. 张铎/杨玮：permissions 含「测试」/「测试02」的 9 个资源（证明 test-role 挂角色后生效，isEnabled=False 不滤）
3. 郑欣：permissions 含 role-zone_manager 的 11 个资源（zone_manager 角色，直挂清理后授权不变）

Run（示例，任取一个已登录 token 解码）:
```bash
TOKEN="<登录返回的 access_token>"  # 通过企微内登录拿
python3 - <<PYEOF
import base64, json, sys
t = "$TOKEN"
parts = t.split(".")
pad = parts[1] + "=" * (-len(parts[1]) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(pad)), ensure_ascii=False, indent=1))
PYEOF
```

- [ ] **Step 5: 回归验证常规登录**

Run: 在企微内正常登录一个普通用户（如郑欣或任一 manager），确认报表页/看板访问正常、数据范围正确（无 503、无权限异常）。

---

## 回滚预案

- **function**：`git revert` Task 2 提交后重新 bundle，SSH PUT + 清 Deno 缓存（同 Task 4 Step 2-3）
- **数据**：test-role 可删除（`delete-role`）；「测试」「测试02」可还原 users 直挂 + roles=[]；role-zone_manager 可还原 users=['shanhai/ZhengXin']（如需）
- **语义**：回滚后回到 get-all-objects 并集（直挂恢复生效）——双氧期语义一致，无残留状态

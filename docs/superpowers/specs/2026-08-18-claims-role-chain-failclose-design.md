# 消费侧 fail-close：claims 只认角色链，禁 permission.users 直挂

日期：2026-08-18
状态：已确认（用户选定方案 A：消费侧 fail-close）
涉及：`functions/wecom-oidc-callback/`（index.js + claims.js）

## 1. 背景与目标

用户裁定授权模型铁律：**资源挂权限 → 权限挂角色 → 角色挂人**（三层模型）。

当前登录取数用 `GET /api/get-all-objects?userId=owner/name` 返回**并集**——同时含「用户直挂 `permission.users`」与「用户角色挂的 permission」的资源，**来源不可区分**，导致 `permission.users` 直挂（绕过角色）能产生作用。这违背三层模型：直挂无角色约束、DB 引擎层（`get_user_perms_strict`）读不到、无同步/审计、僵尸授权风险。

**目标**：从机制上「直接限制住」直挂——不管直挂从 Casdoor UI / API / 脚本哪种来源写入，一律不产生作用。存量直挂按用户决策清理。

## 2. 设计决策（消费侧 fail-close）

| | 现状 | 改后 |
|---|---|---|
| 取数 | `get-all-objects?userId=`（并集，含直挂） | `get-permissions?owner=`（全量）→ 角色链过滤 |
| 过滤 | 无 | 只取 `permission.roles` 命中用户角色码的 `resources` 并集 |
| 直挂 | 生效 | `roles=[]` 匹配不上 → **天然排除** |
| 失败 | → null → C2 503 | 同左（fail-close 不变） |

**为什么角色链取数可行且干净**：
- 登录时**已拿到**用户角色码 `casdoorRoles`（userinfo `roles` claim，index.js 2b 现成提取，已在写 `role_codes` 镜像）
- `get-permissions` 全量返回每个 permission 的 `roles` 字段 → **零新增 API、一次调用**
- 不需要逐角色逐权限多轮查询，也无需回溯并集来源（并集不可溯源，死路）

## 3. 实现

### 3.1 index.js：替换 fetchAllObjects → fetchRolePermissions

```js
// ②' 角色链可达对象（2026-08-18 三层模型强制）：只认 permission.roles 命中用户角色码的 permission resources。
//    get-permissions?owner= 全量；permission.users 直挂（roles=[]）与 groups 挂载天然匹配不上 → 排除。
//    输入角色码 = 登录时 userinfo roles claim（裸名）；permission.roles 是全路径（owner/name）→ 匹配前去前缀。
//    返回 string[]；任何失败返回 null（由 buildClaims 判 C2 → 503）。
async function fetchRolePermissions(issuer, accessToken, roleCodes) {
  try {
    const owner = ...; // 从 CASDOOR_ORG / token 的 owner claim
    const res = await fetch(`${issuer}/api/get-permissions?owner=${encodeURIComponent(owner)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) { console.error(...); return null; }
    const data = await res.json();
    const perms = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : null);
    if (!perms) return null;
    const myRoles = new Set((roleCodes ?? []).map((r) => String(r)));
    const out = new Set();
    for (const p of perms) {
      const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
      const hit = pr.some((r) => myRoles.has(r) || myRoles.has(r.split('/').pop()));
      if (!hit) continue;                       // 直挂（roles=[]）与不命中角色 → 排除
      for (const resName of p.resources ?? []) if (typeof resName === 'string') out.add(resName);
    }
    return [...out];
  } catch (e) { console.error(...); return null; }
}
```

### 3.2 claims.js：新增纯函数 matchRolePermissions（供契约测试）

```js
// 角色码匹配（2026-08-18）：perms = get-permissions 全量；myRoleCodes = 用户角色码（裸名）。
// 只返回命中任一角色的 permission resources 并集。直挂（roles=[]）与 groups 挂载天然排除。
// 纯函数，无 I/O —— claims.test.js 契约断言防回归。
function matchRolePermissions(perms, myRoleCodes) {
  const mine = new Set((myRoleCodes ?? []).map((r) => String(r)));
  const out = new Set();
  for (const p of perms ?? []) {
    const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
    const hit = pr.some((r) => mine.has(r) || mine.has(r.split('/').pop()));
    if (!hit) continue;
    for (const res of p.resources ?? []) if (typeof res === 'string') out.add(res);
  }
  return [...out];
}
```

index.js 的 `fetchRolePermissions` 复用该纯函数（`matchRolePermissions` 传入拉到的 perms 与角色码）。

### 3.3 语义对齐（与 get-all-objects 一致）

1. **角色码归一**：userinfo roles claim 裸名（`manager`）；`permission.roles` 全路径（`shanhai/manager`）→ 匹配时 `split('/').pop()` 归一
2. **isEnabled 不滤**：get-all-objects 原不滤，测试权限 isEnabled=False 改挂角色后照样生效
3. **无角色 → 空集 deny**：`casdoorRoles` 为空 → 空数组 → B1 空集 = deny（正确：无角色即无授权，不是登录失败）

### 3.4 数据流下游零改动

`reachable`（角色链结果）→ `normalizeFriendlyPerm` → `withCoverage` → permissions/data_scope/fields、门店范围展开（**`expandScopeResources` 唯一通道——2026-08-18 废除组织架构推导，`expandGroupsToBranches` 已删除**，无范围资源 = 空集 deny）、`buildClaims` 纯函数、RLS —— **全部不变**。`claims.test.js` 是纯函数测试（reachable 为输入参数），基本不受影响。

## 4. 配套数据清理（一次性写 Casdoor）

| 动作 | 说明 |
|---|---|
| 新建角色 `test-role`（显示名「测试角色」） | 承载测试权限 |
| 「测试」permission → `roles=['shanhai/test-role']`、清 `users` | 张铎测试授权走三层 |
| test-role → `users=['shanhai/ZhangDuo']` | |
| 「测试02」permission → `roles=['shanhai/test-role']`、清 `users` | 杨玮测试授权走三层 |
| test-role → `users` 追加 `['shanhai/YangWei']` | |
| `role-zone_manager` → `users=[]`（清 ZhengXin） | 郑欣仍走 zone_manager 角色，授权不变，数据变纯净 |

## 5. 错误处理

- `get-permissions` 拉取失败 / 非数组 → `null` → C2 503（与现状 get-all-objects 失败同语义）
- 用户无角色 → 空数组 → B1 空集 = deny（不 fail 登录，只无授权）

## 6. 测试

- **单元（纯函数）**：`claims.test.js` 新增 `matchRolePermissions` 契约断言：
  - 直挂 permission（`roles=[]`）→ 被排除
  - 角色命中（含全路径/裸名两种形态）→ resources 收入
  - groups 挂载、roles 全空 → 空数组
  - 现有 buildClaims 用例不动（输入输出不变）
- **登录 E2E（生产）**：改后 ZhangDuo/YangWei（测试角色）、郑欣（zone_manager）登录验证授权可达对象正确

## 7. 部署

- **只改 `functions/wecom-oidc-callback/`（function-only）**：SSH 直调 InsForge API PUT + 清 Deno 缓存，**不触发 GHA**（CLAUDE.md 部署决策规则）
- 数据清理：SSH 调 Casdoor API（client_credentials token）
- 顺序：先数据清理（建 test-role、改挂角色）→ 再部署 function → 验证登录

## 8. 回滚

- function：SSH 直调还原 `fetchAllObjects`（git revert 该文件后 PUT）
- 数据：Casdoor 里 test-role 可删、测试权限可还原 users 直挂、郑欣可还原（如需要）

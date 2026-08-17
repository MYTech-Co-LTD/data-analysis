# Casdoor 角色/权限机制源码级分析 + 落地方案

> ✅ **实施状态（2026-08-17）：方案 B 已真机落地**——5 角色建 + 45/45 active 用户 Role.Users 挂载 + 5 permission（role-*）建 + 旧 basic/full 停用 + 全量对账 44/45 全等 0 差异。配套：assignRoles 改造 update-role、claims.js 去重、outbox 46 条积压清理。详见 §3.3 与 §5。

> 状态：**机制已源码级验证（源码 file:line + 生产真机实测双证据）**。
> 源码：`~/Documents/mytechcode/source-analysis/casdoor`（master commit `7f622b18`，v3.150.0，2026-08-10，与生产 `casbin/casdoor:latest` 一致）。
> 验证日期：2026-08-17。生产：opsh `113.249.101.33`（Casdoor + casdoor-postgres）。

## 一、为什么之前"不通"——三条断链（全源码归因）

| 现象 | 源码根因 | 验证 |
|---|---|---|
| `add-role-for-user` 404 | **本版本 routers/router.go 只注册 5 个 role API**（get-role/get-roles/add-role/update-role/delete-role）。`add-role-for-user` 等是**旧版/其他分支** API，本版本不存在 | 源码 grep：`routers/*.go` 无 add-role-for-user；生产实测 404 |
| 直接 DB INSERT permission 不生效 | p 策略（permission_rule 表）由 `addPolicies()` 在 permission **增删改时**写入（`object/permission_enforcer.go:472`）。**直接 DB 写入绕过 addPolicies** → enforcer 读不到 p 策略 → 0 对象 | 实测：DB INSERT probe-perm → get-all-objects 无 probe；用 add-permission API → 立即生效（39→40） |
| 直接改 `user.roles` 不生效 | 授权链路**从 Role 表 `Users` 字段反查**（`object/role.go:229` `getRolesByUserInternal`: `r.users like %userId%`），**不读 user.roles**。User 表的 roles 字段是展示用（`ExtendUserWithRolesAndPermissions` 计算结果覆盖） | 源码 + 实测：改 user.roles → 无效果；改 Role.Users → 立即生效 |

## 二、Casdoor 角色/权限完整机制（源码级）

### 2.1 数据模型

**Role**（`object/role.go:28-40`）
```go
Owner, Name (PK), DisplayName, Description,
Users []string,   // ★ 角色下挂的用户（授权权威来源）
Groups []string,  // 角色下挂的组
Roles []string,   // 角色继承（父角色）
Domains []string, IsEnabled
```

**Permission**（`object/permission.go:26-56`）
```go
Owner, Name (PK), DisplayName, Description,
Users []string,   // 直接绑定的用户
Groups []string,  // 直接绑定的组
Roles []string,   // ★ 直接绑定的角色
Domains []string,
Model, Adapter, ResourceType, Resources []string, Actions []string, Effect, IsEnabled
```

### 2.2 授权判定（get-all-objects）= 3 路并集去重

`GetAllObjects(userId)`（`object/permission_enforcer.go:613`）→ `getEnforcers(userId)`（579）→ `getPermissionsAndRolesByUser(userId)`（`object/permission.go:455`）：

```
1. getPermissionsByUser(userId)     # permission.Users 直接含我        (permission.go:387)
2. user.Groups → getPermissionsByGroup  # permission.Groups 含我的组    (permission.go:405)
3. getRolesByUser(userId)           # 从 Role.Users 反查我的角色       (role.go:258)
   └─ GetPermissionsByRole(role)    # permission.Roles 含我的角色      (permission.go:421)
4. existedPerms 去重 → 并集
每个 permission → 独立 enforcer → GetAllObjects() 对象并集
```

**关键**：是**并集**（直接绑定 ∪ 组绑定 ∪ 角色绑定），**不是互斥/覆盖**。挂角色不会清空直接绑定。

### 2.3 Casbin 策略（两表分工）

**p 策略 → `permission_rule` 表**（持久化，`getPolicies()` `permission_enforcer.go:124`）：
```
permission.Users ∪ Groups ∪ Roles  ×  Resources  ×  Actions
→ p | <subject> | <resource> | <action> | <effect> | "" | <permissionId>
```
subject 是**用户 id 或角色 id**（当前生产 basic/full 直接绑人 → subject=用户 id；绑角色则 subject=角色 id，已实测验证）。

**g 策略 → 运行时生成**（`loadRuntimeGroupingPolicies()` `permission_enforcer.go:443` → `getRuntimeGroupingPolicies()` 357）：
```
permission.Roles 的角色 → 角色继承展开（role.Roles）→ 从 role.Users 取用户
→ g(<user>, <roleId>)    # 运行时实时从 Role.Users 读，无需持久化
```

**matcher**（内置 model，`permission_enforcer.go:699`）：
```
m = g(r.sub, p.sub) && r.obj == p.obj && r.act == p.act
```

**授权生效链路**：用户 → `g(user, role)` 匹配 → 命中 role 的 p 策略（subject=role）→ objects 展开。

### 2.4 给用户挂角色的正确姿势（本版本）

| 操作 | 正确 API | 说明 |
|---|---|---|
| 建角色 | `POST /api/add-role` + body(Role) | 实测可用 |
| 挂/改用户 | `POST /api/update-role?id=owner/name` + body(全量 Role 含 **users** 数组) | 全量覆盖 Role.Users；**改后 g 策略运行时重读 → 立即生效**（实测 39→40）|
| 删角色 | `POST /api/delete-role?id=owner/name` | 会顺带清理关联 permission 的 roles |
| **不存在** | ~~add-role-for-user / delete-role-for-user / set-role-users~~ | 本版本 404，薄同步禁用 |

## 三、落地方案

### 3.1 目标态（人→角色→权限→能力点）

```
org_users.role_codes（岗位职能）          org_departments 部门名正则
        │ 薄同步 derive-roles 推导                │
        ▼                                        ▼
Casdoor Role（boss/zone_manager/manager/buyer/finance）
        │  Role.Users 挂人（update-role）
        ▼
Permission.Roles 挂角色（permission 不再直接列用户）
        │  Resources 能力点 key
        ▼
permission_rule p 策略（subject=角色）+ g 策略（运行时 user→role）
        ▼
登录 claims.permissions → 功能授权
```

### 3.2 关键决策点（已由业务拍板 2026-08-17）

**D1：角色码 ↔ 数据可见范围（basic/full）映射** — ✅ 已定
- **full（含 `data-analysis:field:cost`）**：boss / zone_manager / finance
- **basic（无 cost）**：manager / buyer

**D2：permission 建模方式** — ✅ 已定 **方案 B（按角色重建）**
- 5 角色 → 5 permission（role-boss/role-zone_manager/role-finance 各 20 资源含 cost；role-manager/role-buyer 各 19 资源）→ 各自 Roles 挂对应角色

### 3.3 实施步骤（方案 B，已真机执行 2026-08-17）

1. ✅ **Casdoor 建 5 角色**（add-role API）——boss(8)/zone_manager(0)/finance(1)/manager(36)/buyer(0)
2. ✅ **迁移用户**：45 个 active 用户按 derive-roles 规则分桶 → update-role 写 Role.Users（全量，一次性）
3. ✅ **建 5 permission**（role-*，add-permission 触发 addPolicies）——full 档 3 个（含 cost）/ basic 档 2 个（无 cost）→ permission_rule 生成 98 条角色 p 策略
4. ✅ **停用旧 basic/full**（isEnabled=false）→ 纯角色权限全量对账 44/45 全等、0 差异（去重后集合；唯一例外 YiBeiMeiShi. Casdoor 无户待 JIT 补建）
   - ⚠️ **副作用（2026-08-17 发现）**：`update-permission` 用 `.AllCols().Update()`（全列更新，`object/permission.go:175`）——停用时 body 只传 `isEnabled:false` + name/owner，**其余字段（users/groups/roles/resources/actions）被清空为 NULL**。导致 Casdoor 权限列表页 Actions 列 `record.actions.map()` → `null.map()` → **页面空白**（`Cannot read properties of null (reading 'map')`）。
   - ✅ **修复**：旧 basic/full 已被角色 permission 完全替代（44/45 全等验证）+ 0 策略残留（permission_rule/casbin_rule 均 0 条）→ **直接删除**（`delete-permission` API）。Casdoor 权限页恢复，5 个 role-* permission 正常显示。
   - 🔒 **教训**：对 Casdoor permission 做任何 `update-permission`，**必须带完整字段**（含 users/groups/roles/resources/actions/effect），否则 AllCols 全列更新会清空其余字段。改 isEnabled 建议直接删除重建，不要局部 update。
5. ✅ **薄同步 assignRoles 改造**：add-role-for-user → update-role 全量 Users；outbox 46 条积压清理归零（45 条与 Role.Users 一致标 done + ZengWei disabled 标 done）
6. ✅ **配套修复**：claims.js permissions 去重（get-all-objects 并集路径重复）；YiBeiMeiShi. casdoor_synced_at 置 NULL 待下轮 JIT
7. ✅ **方案 C：统一视图/看板 + 全量通俗名**（2026-08-17）：5 角色 permission.resources 具名能力改写为**通俗名**
   （如「经营总览」「成本可见」），退役 11 个零消费 `view:*` 死 key，看板能力覆盖报表视图
   （报表授权 ⇒ 视图访问）。迁移脚本 `scripts/migrate-perms-friendly.mjs`（dry-run 默认，`--live` 写入，
   全字段 update-permission 防 AllCols 清空）。
   - **permission.resources 存通俗名**：get-all-objects 返回通俗名 → claims.js `FRIENDLY_TO_KEY`
     / 前端 `LABEL_TO_KEY` 反查 key 归一。**通配（`view-board:*` / `view-kpi:*`）恒为 key**。
   - **消费侧归一**：`buildPermPool`（web）/ claims.js 在过滤前把通俗名还原成 key；
     resource-sync 用 `KEY_TO_LABEL` 写通俗名 resource.name；对账 normKey 归一防误报。
   - **退役 key 清单**：`view:mobile`、8 个 `report_*_gen`、`view:reports-items`、
     `view:wholesale-customers`（见 capability-catalog.ts DEPRECATED）。

### 3.4 风险与回滚

- **窗口期权限归零风险**：若先清 permission.Users 再挂 Roles，中间 get-all-objects 为空 → **必须事务化**：先建角色+挂人（Role.Users），再更新 permission.Roles（此时 Users 仍保留=双保险），**最后**验证全等后清 Users
- **回滚**：permission 直接绑 users 是现状；角色化后若异常，把 permission.Roles 清空、Users 恢复即可（p 策略由 addPolicies 重建）
- **7 天门禁窗口**：2026-08-23 收口前完成迁移验证

## 四、薄同步改造点（assignRoles）

现状 `web/lib/sync/casdoor-client.ts` assignRoles 用 add-role-for-user（404）→ 必须改：
- 读当前 role（get-role?id=owner/name）→ 拿 Role.Users
- diff：toAdd 人 merge 进 Users；toRemove 从 Users 移除
- update-role?id=owner/name + 全量 Role body（含新 Users）
- 幂等：无变化跳过；失败入 outbox（沿用 B6 语义）

## 五、附：验证矩阵（全部已实测）

| 验证点 | 结果 |
|---|---|
| add-role API 可用 | ✅（200，data:"Affected"）|
| add-role-for-user 不存在 | ✅ 404（源码无路由）|
| get-roles 可读 | ✅ |
| update-role 挂 Role.Users → get-all-objects 并集生效 | ✅ 39→40（含 probe）|
| 直接 DB INSERT permission 不生效（绕过 addPolicies）| ✅ 0 对象 |
| 改 user.roles 不生效（授权读 Role.Users）| ✅ 无效 |
| permission.Roles 绑角色 → p 策略 subject=角色 id | ✅ permission_rule 实测 |
| 角色层落地（方案B）后全量对账 | ✅ 44/45 全等 0 差异（去重集合；YiBeiMeiShi. 例外）|
| 薄同步 auto 角色写入幂等（改造后 update-role）| ✅ role_codes 镜像 44 人自动补全，Casdoor Role.Users 45 挂载不变 |
| YiBeiMeiShi.（wecom_id 带点号）JIT 补建 | ⚠️ **Casdoor 拒非法用户名**（add-user：仅允许字母数字/下划线/连字符）；provision 失败入 outbox 重试至 dead-letter（已手动标 done）。**根因：企微账号异常（wecom_id=`YiBeiMeiShi.` 带点号）**，业务侧在企微修正 userid 后同步可解；当前无权限属既成现状（迁移前也无 Casdoor 户，非回归）|

# 推送系统适配：数据范围持久投影（方案 A）· 设计

日期：2026-08-18 · 状态：**用户已批准方案（A = DB 持久投影）+ spec-forge 评估修订已应用（M1-M13）** · 关联：[[2026-08-15-platform-casbin-novu-unified-design]]、[[2026-08-16-platform-iam-standardization-design]]、[[2026-08-18-claims-role-chain-failclose-design]]

> **2026-08-18 spec-forge 评估修订**：4 透镜 + 3 panel + 红队共 9 agent 评审，13 条「必须改」已应用（M1-M13，文中以 `(M#/spec-forge)` 标注）：双形过渡+M6、裸 `*` 删全权、写时 fail-close、归一单源对拍、薄同步/对账接线、scope-signature 读路径、SQL NULL 毒化、Wave 部署+覆盖守卫、reconcile 护栏、回滚方案、temp-grant 裁决、测试链/CI、分支测试。完整报告：`.spec-forge/push-iam-a-eval/final-evaluation.md`。

---

## 1. 背景与问题（实测）

推送引擎 `run_push`（web/lib/push/，唯一入口）的权限源 = `getPermsStrict` → PostgREST RPC `get_user_perms_strict` → `get_user_perms`（SECURITY DEFINER）。权限体系演进后，这个源与「现在的权限机制」已脱节（全部实测）：

| 维度 | 登录/报表（现在） | 推送引擎源 get_user_perms（现在） |
|---|---|---|
| 门店维 | Casdoor `范围\|X` 资源 → resolveScopeKeys → `data_scope.branch_nums`（2026-08-18 唯一真相） | **仍走 org_users.groups × maps_branch_group 组推导**（2026-08-18 已判废除的语义） |
| 品牌/品类 | `data-analysis:brand:*` / `category:*` 资源 → data_scope | **恒 `[]`**（DB 无 Casdoor 资源镜像） |
| 成本 | `data-analysis:field:cost` 资源 → fields.cost | **只查 temporary_grants**（197 已冻结） |
| RLS | scope_match_v2 读 `data_scope` 段 | 代签 JWT 旧形状（顶层四维、**无 data_scope 段**）→ **deny**（实测 0 行） |

结果（实测）：
- 推送明细链接（代签 JWT 旧形状）在真实视图 `report_daily_sales` 上 **0 行**（`scope_match_v2` deny）；新形状（`data_scope.branch_nums`）**正确放行**（3120-0001 → 49 行，通配 → 10578 行）。
- 分区键解析可用：`东部二区`→15 店、`中部二区`→14 店（maps_branch_group 数据就绪）。
- 品牌/品类/成本维变量因 `get_user_perms` 恒空 → `matchesScope` 对所有人 false → 推不出。
- 授权数据（Casdoor resources / 角色挂载）**由用户负责配置**（测试阶段有意为之），本设计数据无关。

## 2. 目标 / 非目标

**目标**
1. 无会话链路（run_push / agent-query / preview）从 DB 投影拿到**与登录 claims 同源**的 `data_scope` + `fields`。
2. 代签 JWT 升级为新形状（含 `data_scope` 段）→ 当前 RLS 正确放行（缺口 1 解）。
3. 品牌/品类/成本维在授权数据配好时恢复可推（缺口 5/6 解）。

**非目标**
- 数值指标取值实现（缺口 3，独立任务，后续 spec）。
- detail_url 路由修复（缺口 2，独立任务，后续 spec）。
- Casdoor 授权数据配置（用户负责；本设计不依赖具体配置内容）。
- 登录 claims 构建 / RLS 执行点（scope_match_v2）/ 生成器：**零改动**。

## 3. 架构总览

```
Casdoor permission.resources（范围|X / data-analysis:brand:* / category:* / field:*）
   │  角色链匹配 matchRolePermissions（2026-08-18 三层模型强制）
   ▼
有效资源键 ──写穿三径──▶ org_users.scope_resources TEXT[]（持久投影，非真相源）
   │                      ① 登录写穿（callback 3b 扩展）
   │                      ② 薄同步（每日 03:17，group-sync 同批）
   │                      ③ drift 对账（diff 写回 + 24h 告警）
   ▼
get_user_perms（SQL 解析：maps_branch_group + dim_branch → 全店收敛）
   ▼
新形状 { data_scope{brands,categories,branch_nums}, fields{cost}, departments }
   ▼
run_push 逐人 realtime → scope 签名分组 → generateScopedJwt（内嵌 data_scope 段）
   ▼
RLS（scope_match_v2 读 data_scope）→ 明细报表/数值按用户门店集裁剪
```

「持久投影」是 spec 已确立的既定机制：`role_codes` 就是「agent-query/run_push/preview 无会话路径的物理载体，也是 Casdoor 宕机数据面不受影响」的载体。本设计把投影对象从「角色」推广到「数据范围资源」，**同一套写穿/对账模型**。

## 4. 投影 schema（迁移 `199_scope_resources_projection.sql`）

```sql
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS scope_resources TEXT[] DEFAULT '{}';
COMMENT ON COLUMN org_users.scope_resources IS
  '数据范围资源键持久投影（方案 A）：Casdoor 角色链可达的范围相关资源键（归一化形态：data-analysis:branch:X（X=范围|后原值）/ data-analysis:brand:* / category:* / field:*），
   无会话链路（run_push/agent-query/preview）经 get_user_perms 解析 data_scope 的唯一输入。非真相源，只被写穿（登录/薄同步/对账）。';
```

**存原始资源键，不存展开门店清单**（与 role_codes 存裸角色码、groups 存裸路径的既有约定一致）：
- 键小：每用户几个键，不是 388 个 branch_num；
- maps/dim_branch 变动可重解析，不写全表；
- 与 resolveScopeKeys 的输入形状一致，登录/推送共用同一语义。

幂等（MIGRATION_TEMPLATE）；内部列无需 GRANT；部署后 restart postgrest（部署 runbook 既有步骤）。

**考虑过但否决**：直接存解析后的 `data_scope` 快照——门店集随 maps 变动会静默过期，且把「解析」埋进写穿，违背「解析单一职责」。原始键 + 读时解析更符合现有投影约定。

## 5. 写穿三径

### 5.1 登录写穿（functions/wecom-oidc-callback）
callback 在 buildClaims 后已持有 `permissions`（角色链资源串）。新增一步：把范围相关资源键（`范围|X` 归一前键、`data-analysis:brand:*`、`category:*`、`field:*`）PATCH 落 `org_users.scope_resources`（PostgREST，与现有 role_codes/groups 写穿同款）。**写失败不阻断登录**（console.error + 进对账 diff 兜底）。

### 5.2 薄同步（每日 03:17，与 group-sync/derive-roles 同批）
org-wide `get-permissions?owner=`（casdoor-client.ts，5min token 缓存）→ 逐人 `matchRolePermissions(user.role_codes)` → 归一化范围键 → **写时 fail-close 验证（§6）** → upsert `scope_resources`。失败入 outbox（幂等键 wecom_id+date）+ 对账告警。**逐人资源计算 = 登录同款逻辑，从「每次推送」搬到「每日后台批」**。

接线（M5/spec-forge，仿 reconcile-groups 完整链）：`web/lib/jobs/reconcile-scope-resources/manifest.ts`（JobManifest，**进 JOBS registry**——M16 教训：不进 registry 不被注册）+ 迁移 201 `scope_resources_reconcile_history`（date PK，UPSERT 幂等）+ cron route（薄同步 03:17 / 对账）+ `notifyWecom` 红区/失败告警。

### 5.3 drift 对账（每日）
对账（接线见 §5.2）：Casdoor 逐人有效资源 vs `scope_resources` 投影 → **在原始资源键层面对比**（Casdoor 资源→归一→scope 前缀过滤 → 与投影比；不做归一后的二次对比，否则 catalog 缺展示名静默丢弃时 diff=0 无告警）→ diff 分级（C/E/M）+ **24h 未收敛告警**。

护栏（M9/S2/spec-forge，防灾难）：
- **org-wide 非空护栏**：`get-permissions` 返回 `[]`/空（owner 错/401/配置期）→ **abort 不清库**（仿 claims.js `!isArray(reachable)→整体失败`），绝不把全量 active 用户投影清成 `[]`。
- **diff 熔断**：changed 超阈值（如 >50% 用户）→ abort + 告警，防一次清全量。
- **解析结果漂移检测（S2）**：同键集合解析后的门店集与上次对账相比变化 → 告警（缓解门店重编号/停用静默指向新店）。

未知键 / 解析失败 → 红区显式反馈，不静默。

## 6. get_user_perms 新形状（SQL 解析）

`get_user_perms` 返回形状从旧四维 key 改为新形状（`data_scope` + `fields`），**解析在 SQL 内完成**——所有消费端（run_push/agent-query/preview）拿到同一个已解析结果，杜绝多消费端各自解析的漂移：

```jsonc
{
  "role_code": "manager",            // 保留（角色 UI 字段）
  "default_landing": null,           // 保留
  "default_metric": null,            // 保留
  "visible_panels": [],              // 保留
  "departments": [...],              // 保留（部分视图 RLS 需要）
  "data_scope": {                    // ★新段
    "brands": ["3120", "64188"],     // data-analysis:brand:* → code 列表
    "categories": ["水果", "标品"],   // data-analysis:category:* → code 列表
    "branch_nums": ["3120-0006"]     // 范围|X → maps/dim_branch 解析（全店→'*'）
  },
  "fields": { "cost": false }        // ★新段：data-analysis:field:cost ∈ resources
}
```

解析规则（SQL 实现，语义对齐 claims.js resolveScopeKeys + collapseFullStore）：
- **branch_nums**：`data-analysis:branch:X`（X=`范围|` 后的原值）→ ①`'*'`/`全店`→`['*']` 短路；②maps_branch_group.group_id 精确命中 → 包内门店并集；③branch_number 直映；④dim_branch.branch_name 唯一命中；⑤中文名重名 → **fail-close 空集**；⑥未知键 → **fail-close 空集 + 告警**。无 branch 资源 → `[]`（B1 空集 = deny）。
- **裸 `*` 非投影键（M2/spec-forge）**：SQL **不设** `@> ARRAY['*']` 全权分支；唯一通配 = `范围|全店` → `data-analysis:branch:全店`（与 `范围|*` → `data-analysis:branch:*`）。裸 `*` 被所有前缀过滤忽略，与 claims.js 对 `*` 的 scope 贡献为空逐位一致（防同输入登录 deny、推送全权）。
- **写穿时 fail-close 验证（M3/spec-forge）**：任一范围键 `resolveScopeKeys` ok:false（未知/歧义）→ **整单投影写 `[]` + 红区告警**；未知键永不进投影。投影因此只含有效键，SQL 解析与键序无关（消解 claims.js 逐键短路 vs SQL 任意命中的顺序依赖）。
- **brands/categories**：`data-analysis:brand:*` / `category:*` 键剥离前缀。
- **cost**：`data-analysis:field:cost` ∈ scope_resources → true；否则 false。
- **全店收敛**：解析结果与 maps 门店全集**集合相等** → 收敛 `['*']`（胖 cookie 修复语义，collapseFullStore）。
- **system:% 服务身份**：`['*']` 宽松形状保留（185 语义）。
- **NOT FOUND 真实用户（离职/不存在）**：deny 形状（189 语义不变）。
- **`get_user_perms_strict`**（引擎路径 strict 闸，与 architecture §6.2「数据范围持久投影」配套）：前置 NULL 闸判定源 = **无 role_codes ∧ 无 scope_resources**（M3 迁移：门店范围源从 **groups → scope_resources**，`org_users.groups` 不再参与范围判定）；**移除 temporary_grants 子句（M11/spec-forge）**——197 已冻结，temporary_grants 不构成授权面，temp grant 不参与判定，避免「过闸但函数不读」的自相矛盾；范围唯一真相 = scope_resources。返回委托 get_user_perms 新形状（双形同源）。

## 7. 代签 JWT 升级（generateScopedJwt）

payload 从旧形状改为新形状：

```jsonc
{
  "role": "authenticated",
  "data_scope": { "brands": [...], "categories": [...], "branch_nums": [...] },
  "fields": { "cost": true|false },
  "departments": [...],        // 目标视图 RLS 需要时携带
  "iat": ..., "exp": ...       // ≤10min
}
```

- **移除**旧顶层 `branch_nums`/`brands`/`categories`/`can_see_cost`/`scope`（新 RLS 只读 data_scope；旧 key 无消费方，185 已摘，代签令牌与登录 claims 同形状）。
- scope 签名（scope-signature.ts）**结构不变**：四维 canonical JSON（brands/branch_nums/categories 排序 + can_see_cost），数据源改为解析后的 data_scope + fields.cost。
- 实测保证：data_scope 段存在 + branch_nums 非空 → scope_match_v2 放行；空段 → deny（符合 B1）。

## 8. 消费侧迁移清单

| 消费点 | 现状 | 迁移 |
|---|---|---|
| `web/lib/push/index.ts` getPermsStrict | 解析旧形状 `{brands, branch_nums, categories, can_see_cost}` | 解析 `data_scope` + `fields.cost` |
| `web/lib/push/push-variables.ts` matchesScope / Perms 类型 | 读 perms.brands/branch_nums/categories | Perms 类型对齐新形状（数据来自 data_scope） |
| `web/lib/push/render.ts` generateScopedJwt | 旧形状 payload | 新形状（§7） |
| `functions/agent-query` | 读 get_user_perms 旧形状 | 迁移 data_scope（归一为 runner 期望形状，**只搬字段不重算 branch_nums**） |
| web preview / 权限页 preview | 读 get_user_perms（如有） | **必须迁移（S9）**：`web/app/api/admin/permissions/preview/route.ts` 的 `effective` 透传读 `data_scope`/`fields`，防 M3 后 undefined |
| `web/lib/push/shadow.ts` / cutover 测试 | 旧形状断言 | **入 Task 6 Files（S10）**：内联 `RenderedGroup.perms` 类型对齐新形状 |

## 9. 对账与契约（防漂移）

- **reconcile-scope-resources**：Casdoor 逐人有效资源 vs 投影 diff → 分级 + 24h 告警 + 非空护栏 + 熔断（§5.2/§5.3）。
- **登录 claims ↔ get_user_perms 一致性**：同一用户、同一 scope_resources 输入下，登录 claims 的 `data_scope`（function 侧 resolveScopeKeys 解析）与 `get_user_perms` 的 `data_scope`（SQL 解析）必须相等——契约/shadow 测试钉死（防 SQL 解析与 JS 解析漂移）。**契约链钉全**：claims.js ↔ scope-expand.ts ↔ SQL（golden fixture 生成 JSON 快照，CI 比对；不只在两个镜像之间比）。
- **scope-expand.ts（web 侧 JS 解析镜像）**：作为一致性契约的**参照实现**（与 claims.js resolveScopeKeys 同语义），供 SQL 解析契约测试共享 fixtures，不做独立消费路径。
- **归一化单源（M4/spec-forge）**：web 侧统一 `import { DISPLAY_NAME_TO_KEY }`（capability-catalog.ts 已导出，单真相）；**FRIENDLY_TO_KEY ↔ DISPLAY_NAME_TO_KEY 全表对拍契约**（claims.js 静态表 vs catalog 展示名逐字相等，含 `组|` 前缀，真实 CATALOG_KEYS round-trip）；catalog 未命中 → 红区（静默丢弃变显式）。
- **scope-signature 读路径（M6/spec-forge）**：`scopeSignature` 改读 `scope.data_scope.brands/branch_nums/categories` + `scope.fields.cost`，canonical key（b/br/c/cost）不变；契约测试钉「不同门店集→不同签名」「不同 cost→不同签名」「`['*']` vs 388 明细→不同签名」（防签名碰撞 → 同组用首用户 scope 渲染全员）。
- **双形过渡 + M6 sunset（M1/spec-forge）**：get_user_perms 过渡期**同源同值双形输出**（旧顶层四维 + 新 data_scope/fields，同一组 SQL 变量推导，杜绝两形漂移）；消费端逐一迁新形状；**M6 显式摘旧 key**，前置 = 全部消费端（agent-query/wecom-oauth/push 引擎/权限预览）确认读新形状。**消费端兜底恒 deny**：`?? []` / `?? false`，禁 `|| ["*"]` fail-open。

## 10. 测试

- **单元**：SQL 解析各分支（分区包 / 全店收敛 / branch_number / 中文名 / 重名 fail-close / 未知键 fail-close）；generateScopedJwt 新形状。
- **契约**：scope-expand.ts vs SQL 解析一致性；claims.js vs get_user_perms 一致性。
- **端到端**（配测试授权数据后）：登录 claims → get_user_perms → run_push shadow → 明细链接用代签 JWT 打开报表 → RLS 放行、门店集正确。

## 11. 里程碑与部署

前置（CLAUDE.md 铁律）：**architecture.md §6.2/§7.4 先更新**（投影机制、get_user_perms 新形状、代签 JWT 形状）。

### 部署（M8/spec-forge：Wave 5 段——migrate.sh 每次重跑全部迁移，「backfill 先于 M3」是开发序非部署序，必须按 Wave 拆发布）

| Wave | 内容 | 部署方式 |
|---|---|---|
| Wave 0 | **SSH function-only 前置加固**：wecom-oauth 兜底 `\|\| ["*"]` → `?? []`（fail-open 翻转修正）+ 清 Deno 缓存 | SSH |
| Wave 1 | 迁移 199 加列 + 登录写穿 + role-scope.ts/契约测试 + 薄同步/对账 cron 接线 + 迁移 201 history 表。**不含 M3（迁移 200）** | GHA |
| Wave 1.5 | **生产 backfill** `backfill-scope-resources.mjs --write` → `guard-scope-projection.mjs`（活跃用户非空投影 ≥90%）→ psql 抽样（boss 含 `branch:全店`、manager 对应键）。**硬门禁，不过不推 Wave 2** | 服务器 ops |
| Wave 2 | 迁移 200（get_user_perms 双形 + strict 闸）+ agent-query/wecom-oauth 消费新形状 + push 引擎/scope-signature/matchesScope 全量 | GHA（迁移+web+functions） |
| Wave 3 | 契约/对账/端到端验证（Task 8） | — |

WIP=1：Wave 0→3 顺序执行，任一时刻一条轨。

### 回滚（M10/spec-forge）
- **部署前备份函数体**：`pg_get_functiondef` 导出 get_user_perms / get_user_perms_strict 留档。
- **M3 与 strict 闸成对回滚**；**M4 必须先于 M3 回滚**（两方向均为破坏窗：M3 回滚旧形状 + M4 新解析 → 崩溃；M3 留新形状 + M4 回滚旧 JWT → 全 deny）。
- **双形过渡使回滚简化**：不部署 M6 = 旧 key 仍输出，旧消费端不破。
- 投影列回滚后**残留无害**（死数据，可留或清空）。

## 12. 后续独立任务（不在本设计）

1. **数值指标取值**（缺口 3）：`getVariableValue` 在代签 JWT 下查 `metric_code` 语义视图真值。**硬约束（S1/spec-forge）**：M7 守卫（live 拒投 `{{code}}` 占位）**放开必须与 per-user 真值过滤实现同窗绑定，禁止单独放开**；方案 A 的 M4 只放开品牌/品类 `*_url` 链接变量，数值变量维持 pre-M4 抑制（避免 M7 拦截面从 branch 扩到 brand/category 的功能回归）。
2. **detail_url 路由**（缺口 2）：指向当前报表中心路由（`/reports/targets/[id]` 等）+ scope 参数。
3. **Casdoor 授权数据配置**（用户）：角色挂载 + `范围|X` 分区资源 + 品牌/品类/成本资源。

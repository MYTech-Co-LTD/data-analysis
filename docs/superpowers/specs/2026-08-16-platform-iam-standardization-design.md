# 平台级 IAM 标准化改造：以 Casdoor 为主导 · 设计

日期：2026-08-16 · 状态：**待用户评审**（D1-D8 用户已原则确认，见「已确认决策」）
来源：用户原则「以 IAM 为标准、Casdoor 为主导对 data-analysis 标准化改造，不考虑工作量，按正确方式想完善」+ 全景设计对话逐节确认
上游：[[2026-08-15-platform-casbin-novu-unified-design]]（已批准，本 spec 是其**标准化深化层**）
关联：`docs/ops/permission-boundary.md`、`docs/architecture.md` §4/§6/§7、casdoor-infra 主线 `docs/2026-08-11-casdoor-company-platform-design.md`

> **修订声明**：本 spec 是 2026-08-15 spec 的演进层。凡本 spec 所述与本 spec 冲突处，以本 spec 为准（用户已确认升级方向）；08-15 spec 保留为历史记录。未提级处全部继承 08-15（角色码契约/镜像表/薄同步/drift/sunset 时点/P0a-U7 阶段/裁决-1~4/十不变量等）。
>
> **对 08-15 的显式演进点**（其余条款不变）：
>
> | 08-15 条款 | 08-15 表述 | 本 spec 演进 |
> |---|---|---|
> | 非目标 #3 | 行级数据权限留在本地 `data_permissions`，永不进 IdP | **三分流上收**：静态枚举（品牌/品类/字段）→ Casdoor resource + Group；`data_permissions` sunset（§5.2） |
> | 架构③ 座位层 | 企微通讯录 → `org_departments` → `org_users.department_ids` | **Casdoor Group tree 中心化**，本地表降级只读投影（§5.3） |
> | 非目标 | claims 八字段 / `pgrst_pre_request` 执行点零改动 | **claims 增加** `groups/data_scope/fields/catalog_v`（§5.4）；执行点 PGRST 行过滤/列掩码机制不变，仅消费新 claim 段 |

---

## 目标

以 IAM 为标准、Casdoor 为主导，对 data-analysis 做标准化改造——**凡授权语义全部收 Casdoor，data-analysis 只留业务执行 + IAM 不覆盖的例外机制**。具体成功标准：

1. **组织架构单一真相源 = Casdoor Group tree**：部门/区域/门店层级全部在 Casdoor 表达；本地 `org_departments/org_users` 降级为只读缓存投影。
2. **功能授权 = capability catalog + casbin resource**：看板/模块/操作/敏感字段全部 `data-analysis:*` 命名空间资源化；**动态发现**：新能力上线零手工建档（catalog 一行 → 部署同步 → 可配 → 生效）。
3. **数据范围 Casdoor 主导三分流**：静态枚举（品牌/品类）→ resource；动态大量值（门店）→ Group tree 挂组表达；临时例外（+到期）→ app 例外表。`data_permissions` 四维表目标 **sunset**。
4. **执行端单一 claims 消费**：OIDC claims（sub/org/roles/groups/permissions/data_scope/field 掩码）一套判定，无第二套逻辑。
5. **零回归**：shadow 对账门禁（授权变更 diff=0）+ Casdoor 故障降级口径诚实（继承裁决-2/裁决-1）。
6. **列级脱敏可扩展**：新增敏感字段 = catalog 加 `field:<slug>` + 掩码配置一行，QA 断言防漏登记。

## 非目标

- **列级脱敏不做通用 DSL**：V1 只做「敏感字段布尔开关 + 既有结构掩码（整列 NULL）」；值级脱敏（如成本 > X 才显示）明确不做，留未来。
- **负向授权不做**：只做白名单正向；撤销 = 摘 resource/组，不建 deny 规则（casbin effect 保留 but 不启用）。
- **Casdoor fork / 插件化扩展 UI 不做**：Casdoor UI 短板（resources 自由标签无下拉）由 data-analysis 出「能力目录辅助页」补，不 fork 上游（casdoor-infra 铁律）。
- **第二应用接入不做**：命名空间 `应用:资源` 全局唯一、机制通用，但实施仅 data-analysis。
- **删除现有通道不做**：wecom-push 退役等推送轨安排继承 08-15，本 spec 不动推送物质链路。

## 全局约束

继承 08-15 全部（门店键铁律、部署规则、时区、C1-C9、WIP=1、语义层零改动）。新增四条：

1. **Group 同步器是唯一自写组件**：Casdoor 原生 wecom syncer 同步用户（源码验证）；`GetOriginalGroups/GetOriginalUserGroups` 返回空带 TODO（`object/syncer_wecom.go`）→ 组织/群组上收必须自写一个组同步器（范围仅此一处，不 fork）。
2. **resource 注册走 Casdoor 原生 API**：`POST /api/add-resource` / `GET /api/get-all-objects`（casbin_api.go 已源码验证）；data-analysis 只写同步 adapter 调之，不 fork 不 hack 存储。
3. **门店↔Group 映射要有自省能力**：`dim_branch`（门店维表）与 Casdoor Group 双向可查（新增映射表或复用 casdoor_synced 模式），供对账/排障/自动发现用——禁止单向写死。
4. **授权组（view-group）是派生对象**：`data-analysis:view-group:<name>` 展开为成员 `view:*` 判定，映射定义在 data-analysis（catalog 内），不复制进 Casdoor policy（Casdoor 只看到组名 resource）。

## 全景架构

```
┌─ Casdoor（IAM 中心，授权唯一真相源）────────────────────────────┐
│  目录    ：用户（原生 syncer）/ Group tree（部门树+区域门店树）      │
│  职位    ：Role（挂 Group → 组内用户经 getRolesByUserInternal 继承）│
│  能力点  ：Permission(resources × actions) + resource 注册表     │
│            （catalog 同步注入 → getAll-objects 动态发现）          │
│  数据范围：resource 化静态枚举（brand/category/field）             │
│            + Group 挂组表达动态门店                                │
│  审计    ：授权变更日志 / 门禁判定                                 │
└────────────────────────────────────────────────────────────────┘
        │ OIDC claims: sub / org / roles / groups / permissions /
        │               data_scope（brands/categorys/branch_nums 派生）
        │               field 掩码 / 版本 + 到期
        ▼
┌─ data-analysis（执行层，无授权语义）─────────────────────────────┐
│  页面门禁(middleware view:*)   requireAdmin(admin)              │
│  PostgREST 行过滤(groups claim→门店) / 列掩码(field claim→NULL)   │
│  例外表：临时授权+到期(授权中心 UI)  授权组映射(view-group catalog) │
│  只读缓存投影：org_users / org_departments（不承担真相）           │
│  同步 adapters：resource 同步 / Group 同步 / claims 构建           │
└────────────────────────────────────────────────────────────────┘
```

### 真相源总表（升级 08-15 §架构·真相源划分）

| 数据 | Source of Truth | 合法写入口 | 对 08-15 的变化 |
|---|---|---|---|
| 人是谁 | Casdoor | 企微 provider / JIT / 薄同步建户 | 不变 |
| 组织架构（部门/区域/门店组） | **Casdoor Group tree** | Casdoor UI + 组同步器（auto） | **★ 中心化：原「企微通讯录→org_departments」** |
| 职位（Role） | Casdoor | Casdoor UI（manual）+ 薄同步（auto） | 不变；闭环经 Group 挂 Role |
| 能力点（功能资源） | Casdoor Permission + resource 表 | Casdoor UI / **catalog 同步 adapter** | **★ 新增 catalog 动态发现** |
| 数据范围-静态枚举（品牌/品类/字段） | **Casdoor resource** | catalog 同步 adapter | **★ 原 data_permissions 四维内** |
| 数据范围-动态门店 | **Casdoor Group 归属** | 组同步器 / Casdoor UI | **★ 原 data_permissions.branch_nums 内** |
| 数据范围-临时例外 | app `temporary_grants` | 授权中心 UI | 新建（原四维内） |
| 人→角色（本地视图） | 持久投影 role_codes（非真相源） | 只被写穿 | 不变（sunset 时点继承） |
| 本地 org_departments/org_users | **缓存投影（非真相源）** | 只读消费 | **★ 降级：不再被写** |

关键变化一句话：**08-15 的「数据范围留在本地 data_permissions」被本 spec 演进为「Casdoor 主导三分流」；08-15 的「人→部门：企微通讯录」演进为「Casdoor Group tree 中心化」。** 其余全部继承。

## 组件

### 5.1 能力点 catalog（新组件）

**形态**：代码真相源 `web/lib/capability-catalog.ts`，推导式自动发现 + 人工覆盖层。

```ts
// 自动发现脚本（scan: 语义层 view-configs + app 路由 + admin 路由 + 手工清单合并）
//   → 生成 catalog 草案 {key, group, label, desc, sensitive?}
// 覆盖层：displayName / group 归类 / sensitive 标记（人工只改覆盖，不重写）
export const capabilityCatalog = defineCatalog({
  auto: await scanViewsAndRoutes(),          // 路由/视图出现 → 自动进 draft
  overrides: {                               // 人工：改名/分组/标记敏感
    'data-analysis:view:reports':   { group: '看板', label: '经营总览' },
    'data-analysis:field:cost':     { sensitive: true },
  },
}) as const;
```

**命名空间**（细粒度看板 + 字段通道已确认）：

```
data-analysis:view:reports            # 逐看板，独立授权（细粒度）
data-analysis:view:reports-items      # 商品下钻
data-analysis:view:reports-targets    # 目标达成
data-analysis:view:wholesale-customers# 批发客户下钻
data-analysis:view:<module>...        # targets/sources*/branches/items/semantic/qa
data-analysis:view-group:<name>       # 授权组＝派生：覆盖一组 view 判定（⑤）
data-analysis:field:<slug>            # 敏感字段列掩码；现 cost，未来 gross_margin 等
data-analysis:brand:3120 / :64188     # 数据范围-静态枚举（品牌）
data-analysis:category:水果 / 标品 / 耗材  # 数据范围-静态枚举（品类）
data-analysis:admin                   # 管理台门禁（现有）
data-analysis:push:broadcast          # 推送广播（现有）
```

**动态发现闭环**（新能力全生命周期）：

```
① 加页面路由 / 语义层新视图
② 自动发现脚本 → catalog 草案（即使忘了手工登记也会被捕获）
③ 部署钩子（GHA step）+ cron 对账（15min）双通道 → add-resource 差集同步
     → Casdoor resource 表 / getAll-objects 出现新条目（原生机制）
④ 管理员 Casdoor 权限对象给角色勾上（或从能力目录辅助页复制 key）
⑤ 校验器（data-analysis 消费侧）：只认 catalog ∪ "*"；未注册 key → 拒绝+告警
     （反向发现：配置了不存在的能力立刻报错）
```

**辅助页**（补 Casdoor UI 短板，不 fork）：`/admin/capabilities` 展示 catalog 全量 + 同步状态（resource 表 vs catalog 差集）+ 校验结果 + 未知 key 告警。

### 5.2 数据范围三分流（对 08-15 §4 口径的演进，核心变化）

| 数据维 | 表达 | 判定路径 | 08-15 现状 |
|---|---|---|---|
| 品牌（3120/64188） | resource `brand:*` | casbin（web 层）→ claims | 本地 data_permissions.brands |
| 品类（3 值） | resource `category:*` | casbin → claims | 本地 data_permissions.categories |
| 门店（~250 动态） | **Group tree 叶子**（用户挂组） | `groups` claim → PostgREST 行过滤 | 本地 data_permissions.branch_nums |
| 敏感字段 | resource `field:<slug>` | casbin → claims → 列掩码 | 本地 data_permissions.can_see_cost |
| 临时例外 | app `temporary_grants` | 登录保证 / 例外表 RT 判定 | 无（四维合并件） |

- **不 resource 化门店的理由**（钉死）：policy 行数 = 门店数 × 授权组合数，每开新店要 add-resource + 重挂权限——resource 表达的是"能力点"，门店是"过滤值"，两者语义不同（08-15 已论证 casbin 无 policy→SQL）。
- **例外表语义**：`temporary_grants(user_id, dim, value, expires_at, note)`——IAM 无到期语义（Casdoor 角色无过期），这是 app 侧唯一授权数据；授权中心 UI 维护；被登录链路折叠进 claims（`exp`min(7d, grant)）。
- **data_permissions sunset**：迁移窗口内表保留（回滚保险），写入口关闭（管理页只读→引导到 Casdoor + 例外/授权组），U2 后按 sun set 删除（含 167 的 role/dept 行读路径删除）。**保留迁移 167 可回滚**。

### 5.3 组织架构 Group tree（对 08-15 §架构③ 的演进，新组件）

- 树结构：org（shanhai）下多棵 Group 根（部门树 / 区域-门店树）；树深示意：
  ```
  shanhai（org）
   ├─ 部门树         ├─ 区域门店树
   │  ├─ 总部         │  ├─ 熊喵-东区
   │  ├─ 采购部       │  │  ├─ 门店A（Group 叶子）
   │  └─ 运营部       │  │  └─ 门店B
   │                   │  └─ 熊喵-西区
   │                   │     └─ 门店C
   │                   └─ 品品甜（另一品牌链）
  ```
- **门店自省映射**：`maps_branch_group(branch_number, group_id) UNIQUE`——dim_branch 与 Casdoor Group 双向可查；登记新店 = dim_branch 建档 + 同步器建 Group + 映射行（3 处一致，对账盯）。
- **组同步器（唯一自写组件）**：企微群组/通讯录部门 → Casdoor Group 树 upsert（幂等；删除限于"同步器建的组"，人工组不动）；用户挂组：企微 dept→auto 挂组 + Casdoor 人工补挂（manual）。单写者语义对齐 08-15 §4.5。
- 消费：OIDC claims 带 `groups`（用户挂的全部组 id/code 路径），SQL 层 `groups ?| branch-group` 过滤门店行。

### 5.4 claims 契约（升级 08-15 八字段）

```jsonc
{
  "sub": "shanhai/ZhangDuo", "org": "shanhai",
  "roles": ["store_manager"],                        // 08-15 已有（角色码契约，裸 code）
  "permissions": ["data-analysis:view:reports", "..." ], // 08-15 已有（catalog 快照）
  // ★新增
  "groups": ["沙海-东区", "沙海-东区-门店A"],           // 挂组路径（SQL 过滤用）
  "data_scope": {                                     // 由 resource 判定 + groups 派生
    "brands": ["3120"], "categories": ["水果"],
    "branch_nums": ["3120-001", "3120-002"]           // 来自 groups 叶子展开
  },
  "fields": { "cost": true },                          // 掩码开关
  "catalog_v": 42,                                     // catalog 版本（校验器比对，旧版本 claims 拒绝高风险）
  "exp": 604800                                        // 7 天（继承 D9）
}
```

- 构建方：登录 function（08-15 已有 claims 构建器）→ 增加"Group 挂载拉取 + resource 判定枚举 + 门店叶子展开"三段；Casdoor `get-all-objects` 一次取全部可达对象（原生），映射成 `data-analysis:*` 子集。
- **不改变执行点**：PostgREST 行过滤仍读 claim（pgrst_pre_request 扁平化，迁移 114 机制复用）；新增 groups 过滤 + fields 掩码照 `perm.ts` 模板写法扩展。
- **catalog_v 校验**：高风险消费（requireAdmin/实查段）比对 catalog 版本，旧 claims（能力已下线）→ fail-close。

### 5.5 授权组 view-group（易用层，细粒度的副作用治理）

细粒度 → 管理员勾选成本高。授权组 = 一组 view 的 union 判定，**映射定义在 catalog（app 侧），不在 Casdoor policy**：

```ts
// catalog 内：data-analysis:view-group:经营看板 → 展开成员
viewGroups: {
  'data-analysis:view-group:reports-all': {
    label: '报表看板全组',
    members: ['data-analysis:view:reports', 'data-analysis:view:reports-items',
              'data-analysis:view:reports-targets', 'data-analysis:view:wholesale-customers'],
  },
}
```

- Casdoor 只见组名 resource（勾选简单）；data-analysis 消费侧展开为成员判定（`get-user-resources` 命中组名 → 展开成员 → 视图可见）。
- 支持嵌套组 + `*` 兜底（继承 casbin Matcher）。

### 5.6 变更传播（事件驱动，替代轮询）

- Casdoor webhook 事件（permission/role/group/user 变更）→ data-analysis web 端点收 → 缓存失效 + 写穿触发。
- 事件驱动为主 + 每日 3-way 对账兜底（08-15 §4.5 扩展：对象集从 roles 扩到 role/group/resource/catalog 四对象）。
- 不可达时退化为 TTL 自然过期（JWT 7 天；实查 5min）。

### 5.7 执行端消费（盘点收口，禁散落判断）

| 面 | 判定 | 数据源 |
|---|---|---|
| 页面可见（middleware） | `data-analysis:view:*` claims/catalog 校验 | 快判（软门禁） |
| admin 管理台 | `data-analysis:admin`（08-15） | requireAdmin + 实查兜底（裁决-1） |
| 报表行过滤 | `groups`+`data_scope.branch_nums` → RLS | PostgREST 行策略（复用） |
| 列掩码 | `fields.cost` → 整列 NULL | 视图模板（perm.ts） |
| push 广播/配置 | `push:broadcast`/`push:configure`（08-15） | 引擎闸 + 实查 |
| 临时例外 | `temporary_grants` 折叠进 claims | 授权中心 |

### 5.8 对账与回滚

- **3-way 对账 × 4 对象**：Casdoor（role/group/resource/permission）vs 本地（claims 声明/org_users 投影/catalog 期望）vs 期望集 → diff 分级（沿用 08-15 C/E/M 语义）+ 24h 未收敛页告警。
- **回滚**：catalog 回滚 = 代码回退 + 同步器反向（已从 resource 表移除的 key 保留标记 deprecated，不立即删防误伤）；Group 同步器删除 = 限自己建的组；例外表回滚 = 授权中心撤销。全部可脚本化（U6 一键 disable 模式复用）。

## 数据流

### 登录链路（本 spec 升级后）

```
Casdoor OIDC → callback → 拉 roles(get-user) + 拉 groups(get-user-groups)
  + 拉可达对象(get-all-objects → 过滤 data-analysis:* 子集 → permissions 平铺)
  + 门店叶子展开(groups → maps_branch_group → branch_nums)
  + 例外表折叠(exp min)
  → 写穿镜像(role_codes/groups 投影, 只读消费) → 自签 JWT(catalog_v 版本戳)
  → claims → middleware / requireAdmin / PostgREST(行过滤+列掩码)
```

### 新增能力上线流（动态发现）

```
路由/视图出现 → scan(cron 或 GHA) → catalog draft
  → 人工覆盖确认(可跳过, 用默认值) → 同步 adapter → Casdoor add-resource 差集
  → resource 表就绪 → 管理员勾角色(或 catalog 辅助页复制 key)
  → claims 重建(登录/batch-enforce) → 校验器放行 + catalog_v 更新 → 生效
```

### Group 同步流

```
企微通讯录变更(webhook/03:17 全量) → 组同步器(upsert Group 树, 幂等)
  → 映射表写 maps_branch_group → 挂组 auto(企微 dept) + manual(人工)
  → 每日对账 Group 树 vs org_departments 期望 → diff 分级告警
```

## 错误处理与降级

| 故障点 | 方向 | 语义 |
|---|---|---|
| resource 同步失败 | outbox | 重放非丢弃（08-15 模式复用）；>48h 页级告警 |
| Group 同步失败 | outbox | 同上；挂组漂移由对账捕获 |
| 未知 resource key（校验器） | fail-close | 拒绝配置项 + 告警（反向发现） |
| catalog_v 过期（能力下线后旧 claims） | fail-close | 高风险消费拒 + 提示重新登录 |
| maps_branch_group 缺失（门店未登记） | fail-close 单门店 | 该门店行不过滤降级为不可见 + 告警（不静默全放） |
| Casdoor 不可达 | 继承裁决-2 | 存量会话 + 数据面零影响；新登录 <2-4h；实查 fail-close + 24h stale |
| 例外交互超时 | 降级 | 例外不折叠（等同无例外），审计记录 |

**残余风险（新增项，其余继承 08-15 R1-R8）**：

| # | 残余 | 理由 | 缓解 |
|---|---|---|---|
| R9 | 组织架构全量上收后 Casdoor 单点面扩大（目录+授权+范围） | IAM 主导的必然代价 | 缓存投影 + 断网口径 + 组同步器本地重放 + 对账盯漂移 |
| R10 | 组挂载继承依赖 Casdoor getRolesByUserInternal 行为（版本演进被改） | 不 fork 依赖上游 | 契约测试冻结「Group→Role 继承」行为（升级 V2 快照） |
| R11 | view-group 展开映射错配 → 授权面意外放大 | 派生对象 | catalog 校验（成员必须存在）+ 对账 + 审计读权限对象时展开比对 |
| R12 | 列级脱敏未来要值级（成本>X）时技术债残留 | V1 边界 | catalog 敏感标记为未来值级留字段位，不现在实现 |

## 测试

（分层按 docs/testing-handbook.md §2；渗透清单 T1-T15 继承，新增组目录类。）

- [ ] catalog 校验器：合法 key / `*` / 未知 key 拒绝（单测红绿）
- [ ] 自动发现脚本：路由+视图新增 → draft 新增行（快照测试）
- [ ] add-resource 同步器：幂等（重跑 no-op）; diff 空（对账 exit 0）
- [ ] Group 挂 Role 继承行为契约测试（冻结 R10）
- [ ] claims 契约快照：新增 groups/data_scope/fields/catalog_v 字段（V2 升级）
- [ ] 门店行过滤：挂组用户可见该门店行；未挂不可见；映射缺失 → 不可见+告警（伪造 claims 参数化，本地）
- [ ] 列掩码：fields.cost=false → 成本列 NULL（视图模板改后回归 08-15 脱敏断言）
- [ ] 临时例外：到期后 claims 折叠消失（注入测试）
- [ ] 3-way 对账 × 4 对象：注入差异 → 对应分级告警
- [ ] 迁移幂等：data_permissions 写入口关闭后管理页只读、167 回滚脚本演练

## 实施阶段（W 轴并入 08-15 轨迹，不额外占主线窗口）

> 说明：标准化的收拢动作与已批准的推送/身份轨交织（U 轴照旧），W 轴利用 P0b/U1 浸泡期并行推进；WIP=1 纪律不变——W 轴的每个阶段仍是独立可合入的完整段。

```
W1  catalog + resource 同步 + 校验器（只登记不强制，默认 observe）
    就绪：scan/同步/校验三脚本绿；辅助页可看 synced 状态
W2  Group 同步器 + maps_branch_group + groups claim（先只写不读，影子对账）
W3  claims 契约扩展（data_scope/fields/catalog_v）——与 U2 登录切换同一发布窗（避免双次登录链路改版）
W4  静态枚举 resource 化 + 消费侧切（品牌/品类判定走 claims）+ shadow 对账 ±0
W5  例外表上线 + data_permissions 写入口关闭 + 管理页只读引导 + 授权组 view-group 放量
W6  data_permissions 表删除（sunset，167 回滚脚本演练）
```

- W3 必须与 U2 同窗（登录链路只改一次）；其余各 W 可在 U 轴任意间隙落。
- 决策 D1/D2 意味着 W2/W4/W5 是**形态正确路径**（不看工作量）；如果运行中发现挂组运维不可持续，例外层兜住（不反向恢复 data_permissions——回滚路径是例外表扩容，不是恢复四维表）。

## 已确认决策（用户原则批准，D1-D8）

1. **看板分级细粒度**：逐看板 `view:*`，不做组级大揽权；授权组（view-group）作为易用层可配可省。
2. **列级脱敏留扩展空间**：`field:*` 统一命名 + 两步扩展法（catalog + 掩码配置），生成器不动。
3. **动态发现机制**：catalog 自动发现（代码派生）+ 部署钩子 + cron 对账 + 校验器（认 catalog∪`*`，未知 key 拒绝）双向通道。
4. **D1 门店上收 Group tree**（每门店一组、人挂组）。
5. **D2 data_permissions 全撤**，只留例外表。
6. **D3 品牌/品类独立 resource 化**（不并入 view:* 判定）。
7. **D4 授权组要**（易用层）。
8. **D5 部署钩子 + cron 对账双通道同步**。
9. **D6 变更传播 webhook 事件**（非轮询）。
10. **D7 例外表放 app**（IAM 无到期语义）。
11. **D8 casbin 实查默认开**（裁决-1 继承，shadow 一周 ±0 后转正，E2E 冒烟）。

## 架构文档更新（CLAUDE.md 铁律，实施前完成）

- `docs/architecture.md`§4.2-4.4：组织架构改 Casdoor Group tree 中心化；§4.3 信任边界补 Group 同步器与 resource adapter。
- §6：真相源总表替换（三分流 + catalog + groups claim）；§6.4 新增能力点 catalog 与动态发现。
- §7.1.2：薄同步扩为「用户同步（原生）+ 组同步器（自写）双轨」；补 maps_branch_group/resource 同步。
- 新增 §6.5 授权组 view-group 与例外表；§九 追加已确认决策 D1-D8。
- `docs/ops/permission-boundary.md`：三者边界表新增「目录=Group tree」「数据范围三分流」，删「data_permissions 四维」表述，标注转移到 Casdoor/例外表。

---

程序性说明：本 spec 是 08-15 的标准化深化层，继承全部未提级接口与阶段；「修订声明」确保两份文档不打架；D1-D8 为用户 2026-08-16 原则批准记录在此，未单独逐条 gate。待用户评审后进入 writing-plans。
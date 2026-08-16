# 平台级 IAM 标准化改造：以 Casdoor 为主导 · 设计

日期：2026-08-16 · 状态：**revision-2：已按四 lens 评审（method/contract/feasibility/redteam）修订**，待用户终审（D1-D8 用户已原则确认，见「已确认决策」）
来源：用户原则「以 IAM 为标准、Casdoor 为主导对 data-analysis 标准化改造，不考虑工作量，按正确方式想完善」+ 全景设计对话逐节确认 + spec-forge 评审 findings（`.spec-forge/iam-std-review/merged-findings.md`）
上游：[[2026-08-15-platform-casbin-novu-unified-design]]（已批准，本 spec 是其**标准化深化层**）
关联：`docs/ops/permission-boundary.md`、`docs/architecture.md` §4/§6/§7、casdoor-infra 主线 `docs/2026-08-11-casdoor-company-platform-design.md`

> **修订声明**：本 spec 是 2026-08-15 spec 的演进层。凡本 spec 所述与本 spec 冲突处，以本 spec 为准（用户已确认升级方向）；08-15 spec 保留为历史记录。未提级处全部继承 08-15（角色码契约/镜像表/薄同步/drift/sunset 时点/P0a-U7 阶段/裁决-1~4/十不变量等）。
>
> **revision-2 修订记录**（2026-08-16，四 lens 评审后机械誊写，参考 `.spec-forge/iam-std-review/merged-findings.md`）：B1-B6（空集 fail-open/permissions 断言/shadow 基线/存量回填/例外表时效/claims 双氧期）、H1-H16、S 级 14 项及勘误（get-user-groups→useGroupPathInToken；get-all-objects vs get-resources）全量纳入；「没问题」7 项确认保持不动。
>
> **对 08-15 的显式演进点**（其余条款不变）：
>
> | 08-15 条款 | 08-15 表述 | 本 spec 演进 |
> |---|---|---|
> | 非目标 #3 | 行级数据权限留在本地 `data_permissions`，永不进 IdP | **三分流上收**：静态枚举（品牌/品类/字段）→ Casdoor resource + Group；`data_permissions` sunset（§5.2） |
> | 架构③ 座位层 | 企微通讯录 → `org_departments` → `org_users.department_ids` | **Casdoor Group tree 中心化**，本地表降级只读投影（§5.3） |
> | 非目标 | claims 八字段 / `pgrst_pre_request` 执行点零改动 | **claims 增加** `groups/data_scope/fields/catalog_v`（§5.4）；执行点 PGRST 行过滤/列掩码机制不变，仅消费新 claim 段；**四维旧 key additive 双氧，W6 前不删**（B6）；**列掩码消费位收口 = 非生成器运行时层**（"生成器零改动"改述为"生成器只接受 catalog 驱动输入"，H7，见 §5.7） |
> | **新增第 4 条** | 功能授权真相源 | **功能能力点真相源 = catalog 驱动（代码）+ casbin Permission(resource) + 同步 adapter**；Casdoor UI 手配仅限 catalog ∪ `*` 内，非 catalog key 被校验器 fail-close（08-15 的「Casdoor UI 自由配置」面收窄为 catalog 驱动，契约 F7） |

---

## 目标

以 IAM 为标准、Casdoor 为主导，对 data-analysis 做标准化改造——**凡授权语义全部收 Casdoor，data-analysis 只留业务执行 + IAM 不覆盖的例外机制**。具体成功标准：

1. **组织架构单一真相源 = Casdoor Group tree**：部门/区域/门店层级全部在 Casdoor 表达；本地 `org_departments/org_users` 降级为只读缓存投影。
2. **功能授权 = capability catalog + casbin resource**：看板/模块/操作/敏感字段全部 `data-analysis:*` 命名空间资源化；**动态发现**：新能力上线零手工建档（catalog 一行 → 部署同步 → 可配 → 生效）。
3. **数据范围 Casdoor 主导三分流**：静态枚举（品牌/品类）→ resource；动态大量值（门店）→ Group tree 挂组表达；临时例外（+到期）→ app 例外表。`data_permissions` 四维表目标 **sunset**。
4. **执行端单一 claims 消费**：OIDC claims（sub/org/roles/groups/permissions/data_scope/field 掩码）一套判定，无第二套逻辑。
5. **零回归**：shadow 对账门禁（授权变更 diff=0）+ Casdoor 故障降级口径诚实（继承裁决-2/裁决-1）。
6. **列级脱敏可扩展**：新增敏感字段 = catalog 加 `field:<slug>` + **掩码由非生成器运行时层消费**（H7，revision-2）；QA 断言扩为衍生列血缘断言（margin/rate 全列随基列 NULL）。

## 非目标

- **列级脱敏不做通用 DSL**：V1 只做「敏感字段布尔开关 + 既有结构掩码（整列 NULL）」；值级脱敏（如成本 > X 才显示）明确不做，留未来。
- **负向授权不做**：只做白名单正向；撤销 = 摘 resource/组，不建 deny 规则（casbin effect 保留 but 不启用）。
- **Casdoor fork / 插件化扩展 UI 不做**：Casdoor UI 短板（resources 自由标签无下拉）由 data-analysis 出「能力目录辅助页」补，不 fork 上游（casdoor-infra 铁律）。
- **第二应用接入不做**：命名空间 `应用:资源` 全局唯一、机制通用，但实施仅 data-analysis。
- **删除现有通道不做**：wecom-push 退役等推送轨安排继承 08-15，本 spec 不动推送物质链路。

## 全局约束

继承 08-15 全部（门店键铁律、部署规则、时区、C1-C9、WIP=1、语义层零改动——后者在 §5.7 列掩码处按 H7 改述为"生成器只接受 catalog 驱动输入"，消费位收口在非生成器运行时层）。新增六条：

1. **Group 同步器是唯一自写组件**：Casdoor 原生 wecom syncer 同步用户（源码验证）；`GetOriginalGroups/GetOriginalUserGroups` 返回空带 TODO（`object/syncer_wecom.go`）→ 组织/群组上收必须自写一个组同步器（范围仅此一处，不 fork）。
2. **resource 注册走 Casdoor 原生 API**：`POST /api/add-resource` / `GET /api/get-all-objects`（casbin_api.go 已源码验证）；data-analysis 只写同步 adapter 调之，不 fork 不 hack 存储。
3. **门店↔Group 映射要有自省能力**：`dim_branch`（门店维表）与 Casdoor Group 双向可查（新增映射表或复用 casdoor_synced 模式），供对账/排障/自动发现用——禁止单向写死。
4. **授权组（view-group）是派生对象**：`data-analysis:view-group:<name>` 展开为成员 `view:*` 判定，映射定义在 data-analysis（catalog 内），不复制进 Casdoor policy（Casdoor 只看到组名 resource）。
5. **catalog 单真相纪律（H12，与生成器铁律同级，须写入 CLAUDE.md）**：`capabilityCatalog` 只存在于 `web/lib/capability-catalog.ts` 单副本；function（claims 构建器）**只消费不内嵌复制** catalog 子集——function-only 部署（SSH 直调，CLAUDE.md 部署规则）会绕过 catalog scan 制造漂移副本，属违规。新增视图/路由只改 web/lib；claims 构建器永远从 web 侧契约快照/实查读 catalog 判定。
6. **空集 = deny 铁律（B1）**：claims 含 `data_scope`/`groups` 段但值为空 = 授权确定为 ∅ = deny，**不收敛 `["*"]`**。08-15「空数组 → `["*"]` 数据维兜底全放行」仅限 legacy（无新 claim 段的旧 claims 双氧期）——W4 消费侧切走后必须移除；任何挂组缺失（JIT 建户未挂组/组同步器失败/唯一组被删/组接口超时）→ 该用户门店范围为空集，**不进全放**，这与「门店未登记 → 单门店 fail-close 不可见」互补覆盖「用户无组」侧。
  - **★enforce 机制（redteam-lite M1 补封，上轮 BLOCKER C1 的机制复发点）**：`claim_match_or_star`（072 L161-177）**空数组/NULL 即放行**、现有 RLS 全经它读顶层旧 key、114 只扁平顶层 → 空集 deny 不能靠这两者执行。两处闭口联合钉死：
    ① **RLS 策略分支（推荐）**：新 RLS 判定函数先看 `request.jwt.claims.data_scope` 形状——存在（非 NULL；114 会按顶层对象扁平 data_scope，RLS 可 `::jsonb ->>'branch_nums'` 定位、以 IS NOT NULL 区分新旧 claims）→ 读 data_scope 各维（**空段 = deny**）；缺失 → 回退 legacy 顶层 key（走 claim_match_or_star）。分支本身即新旧 claims 的**形状鉴别器**，与 072 语义天然隔离；W4 切走只需删回退支。
    ② 备选哨兵方案：新 claims 顶层旧 key 写非空非 `"*"` 哨兵 `["__none__"]`（072 对非 `"*"` 非空数组返回 false = deny）——但 W4 后需清哨兵值，不如策略分支干净。
    **两案实施时二选一钉死（推荐 ①，终审勾确认）；W3 前置必改，否则「W3 切换后零组/挂组失败用户 → 新 claims 空 data_scope 但旧路径 072 全放 → 读全部门店」路径可被遵循文本实现出来。**
  - **豁免窗口（redteam-lite S4）**：legacy 空数组→全放仅限无 data_scope 段的旧形状令牌；W3 起新签发带 data_scope 的令牌一律走空集 deny。W3 后仍在途的旧形状令牌给显式短 TTL（≤48h，随 catalog_v 版本戳刷新会话）压缩宽松窗口。

## 架构（全景）

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
push:broadcast / push:configure       # 推送广播/配置（08-15 裸 key，勿加 data-analysis: 前缀——引擎字面量校验，前缀将致恒 403，H4）
```

**动态发现闭环**（新能力全生命周期）：

```
① 加页面路由 / 语义层新视图
② 自动发现脚本 → catalog 草案（即使忘了手工登记也会被捕获）
     ★删除方向（H14）：此闭环只增不减，下架不自动撤销——删除走「人工确认的废弃清单」
       → 校验器对该 key fail-close + 告警；辅助页展示废弃态；审计「授权对象仍引用废弃 key」项
       ▲废弃清单生命周期（redteam-lite M2）：载体 = catalog 内 deprecated 集合（app 侧唯一真相，
         不入 Casdoor）；owner = 平台管理员；deprecated → removed 驱逐判据 = 清单发布 ≥30 天 ∧
         审计确认无「具名 + 通配」引用 ∧ cron 对账红区清零，由平台管理员执行并留痕。
       ▲通配残余（M2）：持 `view:*`/`brand:*`/`category:*` 的角色对已下架 key **保留能力直至改
         permission**——解析期校验（§5.4 catalog_v 判定）只挡具体点名 key，`view:*` 本身 ∈
         catalog ∪ "*" 合法通过。此残余显式声明为已知接受；审计「仍引用废弃 key」排查项必须含
         **通配持有者列表**（引用的是 `*` 非具名 key，普通按 key 审计显示不出）。
③ 部署钩子（GHA step）+ cron 对账（15min）双通道 → add-resource 差集同步
     → Casdoor resource 表 / getAll-objects 出现新条目（原生机制）
     ★adapter 幂等与怪癖（H3）：add-resource = 裸 Insert（PK=owner+name，重复即报错；
       GetResource 查表恒加 "/" 前缀）→ adapter 统一对 name 加 "/" 前缀写入、读取同样归一化；
       幂等 = 先 GetResources 差集 → 只插缺口；并发撞 PK → retry + 吞 duplicate error
       （或 cron 独占/advisory lock）；只增改不删（delete 挂 Storage provider，无 Storage 不可用，
       与 deprecated 回滚自洽）；adapter 代码注释钉死该怪癖。add-resource 幂等性列入 V2 源码验证硬项。
       **charset 验证（L2）**：`category:水果`/`field:cost` 等含中文/冒号/星号的 resource name 在
       Casdoor add-resource 的字符集校验行为未验证——列为 V2 源码验证项；**同步失败若静默跳过 →
       能力永不可配**，adapter 对每个 key 的 add 结果显式反馈（成功/失败/重试），失败进对账红区。
     ★资源表 vs policy 双源（F11）：resource 表=注册表（辅助页 synced 看它，get-resources）；
       Permission.resources=真授权语义（claims 走 get-all-objects）。3-way 对账对象须含
       permission.resources 与 catalog 差集并写明判定基准（§5.8）。resource 行允许人改，但对账
       白名单高亮「synced 标记」+ diff 告警（可接受，不强制单写）。
④ 管理员 Casdoor 权限对象给角色勾上（或从能力目录辅助页复制 key）
     ★通配授权 = 自动扩容（M1）：任 permission 含 `view:*`/`view-group:*`/`brand:*`，
       新增能力即被该通配自动覆盖——「新能力默认未授权」只对具名 key 成立。通配授权列入
       高风险清单（高风险类单独审计 + 24h 新资源 diff 观察）。
⑤ 校验器（data-analysis 消费侧）：只认 catalog ∪ "*"；未注册 key → 拒绝+告警
     （反向发现：配置了不存在的能力立刻报错）
```

**辅助页**（补 Casdoor UI 短板，不 fork）：`/admin/capabilities` 展示 catalog 全量 + 同步状态（resource 表 vs catalog 差集）+ 校验结果 + 未知 key 告警 + 废弃 key 展示（含「授权对象仍引用废弃 key」排查项）。

### 5.2 数据范围三分流（对 08-15 §4 口径的演进，核心变化）

| 数据维 | 表达 | 判定路径 | 08-15 现状 |
|---|---|---|---|
| 品牌（3120/64188） | resource `brand:*` | casbin（web 层）→ claims | 本地 data_permissions.brands |
| 品类（3 值） | resource `category:*` | casbin → claims | 本地 data_permissions.categories |
| 门店（~250 动态） | **Group tree 叶子**（用户挂组） | `groups` claim → PostgREST 行过滤 | 本地 data_permissions.branch_nums |
| 敏感字段 | resource `field:<slug>` | casbin → claims → 列掩码 | 本地 data_permissions.can_see_cost |
| 临时例外 | app `temporary_grants` | 登录保证 / 例外表 RT 判定 | 无（四维合并件） |

- **不 resource 化门店的理由**（钉死）：policy 行数 = 门店数 × 授权组合数，每开新店要 add-resource + 重挂权限——resource 表达的是"能力点"，门店是"过滤值"，两者语义不同（08-15 已论证 casbin 无 policy→SQL）。
- **例外表语义**：`temporary_grants(user_id, dim, value, expires_at, note)`——IAM 无到期语义（Casdoor 角色无过期），这是 app 侧唯一授权数据；授权中心 UI 维护。
  - **不走 JWT 折叠（B5，废除 rev1 的「折叠进 claims exp min(7d, grant)」）**：例外是风险最高通道且行数极少，实查段做 **5min 缓存实查 temporary_grants**（命名钉死 = TTL 缓存，非每请求 DB 查询）——撤销 ≤5min 生效（健康态），贴合「例外在 app 侧」定位。
    - **三处粒度统一（redteam-lite M3）**：正文「即刻生效」/ 测试「≤5min」/ 降级「24h stale」口径冲突 → 统一为「**健康态撤销 ≤5min 生效；降级态（Casdoor 不可达）沿用裁决-1 24h stale 上限**」。temporary_grants 是**本地表**，裁决-1 的「24h stale」是为远端实查设计的——**本地查的降级 = DB 不可达 → fail-close（等同无例外，见错误处理表），不产生 24h 窗口**。
    - **缓存主动失效（M3）**：授权中心 UI 撤销/删除例外时**同步清该 sub 的例外 RT 缓存**（TTL 立即作废），不靠 TTL 兜底；H16 的 token_blacklist 是数据面 JWT 黑名单，**不是例子缓存失效通道**，两者分开。
    - **RT→RLS 通道（M3，防实现倒退回折叠=重开 B5）**：例外门店集经 `pgrst_pre_request` **每请求并集进 request.jwt.claims**（新增专用 claim 段），天然覆盖 PostgREST 全通道（含直连 SQL/联邦查询）；middleware 快判同源。**禁止登录时折叠进 data_scope / 旧四维 key**——那会重现 7 天撤销窗口（B5 原样回归）。
    - 备选（若实查不可行）：例外单独短 TTL(≤24h) 折叠 claims + 镜像列 `revoked_at` + 批量 enforce 通道清理；至少显式声明并接受「解除 ≤7 天生效」。**选型：RT 查（默认），实施时以裁决-1 实查机制复用为准。**
  - **例外授予面门禁（M4）**：授/撤例外需 `data-analysis:grant`-类 capability + 全量进 permission-audit + 单次授额上限（一店/维度到期天数上限）+ 双人复核可选配置；防「app 侧自授读店」通道。
- **data_permissions sunset**：迁移窗口内表保留（回滚保险）；**DB 级写入口关闭**（H9）：迁移级 `REVOKE`（refresh RPC、/api/admin/permissions 等全部写者）或 `BEFORE INSERT/UPDATE` 触发器禁写 + **直写注入测试（红转绿才放行）**——管理页只读仅是 UX 层表现，不等于单写者；U2 后按 sun set 删除（含 167 的 role/dept 行读路径删除）。**保留迁移 167 可回滚**。

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
- **组类型三态（H13）；钉死展开语义**：①门店叶子组 → `maps_branch_group` 直映 branch_number；②区域组（如 熊喵-东区）→ **子孙门店叶子并集**；③部门/职能组（总部/采购部）→ **不参与 branch 展开**。空集 = 空 scope 非 NULL（消费侧可区分，见铁律 6）；未知组类型 → fail-close + 告警。契约测试覆盖三态 + 未知组类型。
- **门店自省映射**：`maps_branch_group(branch_number, group_id) UNIQUE`——dim_branch 与 Casdoor Group 双向可查；登记新店 = dim_branch 建档 + 同步器建 Group + 映射行（3 处一致，对账盯）。**映射只校验「门店→组」存在；「谁该挂哪组」的挂载语义正确性靠独立期望源对账（H10，§5.8）**。
- **组同步器（唯一自写组件）——两通道显式分离（H2）**：
  - 部门树：企微 webhook / 03:17 全量 → upsert（企微通讯录部门）。
  - **门店树：由 diff(dim_branch vs maps_branch_group vs Group 树) 驱动，不挂在企微 webhook**——门店在企微未必有部门，企微通知到不了新店/改名；改名 = 新名 upsert + 旧名摘挂/标 deprecated。两通道命名空间分离防互串。
  - 建树强制**先父后子**（H1）：`ParentId` 存父 Name，父子链任一断裂（重命名/中断/先子后父）会触发原生 `GetUserFullGroupPath` return error → **该组内所有用户 JWT 签发失败、登录崩**。→ 每日父链完整性校验 + 组树完整性指标（辅助页亮灯，fail 告警）。
  - 删除限于"同步器建的组"（原生 Group 有子组/挂用户即拒删；门店停用 = isEnabled=false + 摘挂 + Properties 打标，非真删——**这两条原生行为列入 V2 源码验证**）；用户挂组：企微 dept→auto 挂组 + Casdoor 人工补挂（manual）。单写者语义对齐 08-15 §4.5。
  - **审计归因（H15）**：同步器写操作带「自动化」标记，与 Casdoor UI 人工勾挂区分；admin 自挂/挂改 store 叶子组 = 高风险事件 → 接入告警 + 审计快照。
- **groups 投影 schema（F9）**：写穿镜像给 `org_users.groups`（或等价投影列/表），供无会话路径（run_push 逐人 perms、agent-query/preview）算门店行；对账/排障读它。
- **org_departments 双源切换（L3）**：只读切换期内，152/refresh 与权限页 dept tab 读路径若仍读旧列 → 双源显示不一致——W 轴切前列该等消费点清单（087 先例），统一指向投影。
- 消费：OIDC claims 带 `groups`（用户挂的全部组 id/code 路径），**SQL 层用 `jsonb @>`/`?` 精确匹配**（`groups ?| branch-group-id` 数组精确命中），禁止前缀/LIKE 匹配（组名可含分隔符会有前缀碰撞）；登记校验禁组名含分隔符（与 maps_branch_group 同约束）。

### 5.4 claims 契约（升级 08-15 八字段）

```jsonc
{
  "sub": "shanhai/ZhangDuo", "org": "shanhai",
  "roles": ["store_manager"],                        // 08-15 已有（角色码契约，裸 code）
  "permissions": ["data-analysis:view:reports", "push:broadcast", ...],
  // ★revision-2：permissions 值从 08-15 四维维度 key（branch_nums/brands/categories/can_see_cost，
  //   现状生产者 wecom-oidc-callback L146-166）迁移为 data-analysis:* 资源串 + push: 裸 key（B2/H4）。
  //   该迁移显式列入 W3 变更集；push 保持裸 key 与引擎一致。admin 门禁判定 data-analysis:admin 不变。
  // 保留字段（additive，H5）：role_code / visible_panels / default_landing / default_metric / departments
  //   （08-15 C4/C5 契约，前端权限页/落地页消费；不得从示例块消失）
  "groups": ["shanhai/沙海-东区", "shanhai/沙海-东区-门店A"],  // ★新增：完整路径精确数组（id/code 稳定路径，
                                                   //   禁中文 label 进判定，label 仅展示；改名不断链）
  "data_scope": {                                     // ★新增：由 resource 判定 + groups 派生
    "brands": ["3120"], "categories": ["水果"],
    "branch_nums": ["3120-001", "3120-002"]           // 来自 groups 叶子展开
    // ★空值语义（B1）：本段存在但值为空数组 = authorized ∅（deny），不收敛 ["*"]，不进全放
  },
  "fields": { "cost": true },                          // ★新增：掩码开关
  "catalog_v": "20260816.1",                           // ★revision-2：= 代码/部署版本戳（非自增计数）；只做 key 级
                                                    //   按需 fail-close，不做全局版本拒绝（H6/M5+F10+M2）
  "exp": 1789917692                                    // ★revision-2：epoch 语义（重写示例为绝对时间戳；文档不
                                                    //   再示例相对时长——照抄会签发已过期 token，L1）
  // 双氧期（B6）：branch_nums/brands/categories/can_see_cost 顶层旧 key 【保留】，data_scope/fields 仅新增
  //   消费；W6 sunset 前不删旧 key——否则 114 顶层扁平化下旧 key 变 NULL → 既有 RLS 静默全放（回归修复前）
  //   ★值判据（redteam-lite M1，W3 前置必改）：新 claims 顶层旧四维 key 的值 = 全维非空镜像（与
  //   data_scope 一致的收敛值）；RLS 以 data_scope 段存在性为形状鉴别器优先读 data_scope（空=deny）、
  //   缺失回退 legacy（全局约束 6 策略分支）。禁止在新 claims 里把顶层旧 key 写空数组/省略——
  //   072 空数组/NULL→true 全放（策略分支方案下旧 key 值仅剩兼容展示/审计用，判定不读它）
  // 契约演进（contract 复验）：08-15 §5.2a 四维 scope 签名 schema（canonical JSON）随 data_scope/fields
  //   变形的演进形态 = 本块新结构；旧签名消费点（perm.ts scope-signature）同 W3 迁移清单（见 H5 保留、H7 清单）
}
```

- 构建方：登录 function（08-15 已有 claims 构建器）→ 增加"Group 挂载读取 + resource 判定枚举 + 门店叶子展开"三段。
  - **Group 读取勘误（F4）**：Casdoor 原生配置 `useGroupPathInToken` 后**原生 OIDC token 自带 groups 全路径 claim**（token_jwt.go:516），解析它即可；「get-user-groups」路由不存在，**不得调用**——或用 get-account 读 `user.Groups`。
  - Casdoor `get-all-objects` 一次取全部可达对象（policy 侧，`permission_enforcer.go`），映射成 `data-analysis:*` 子集；**资源同步状态/辅助页 synced 用的是 `get-resources`（注册表侧）——两 API 语义不同，勘误钉死**（F11）。
  - 三段任一步失败 → **本次登录不产出门店范围（deny）或登录整体失败；禁止以空数组继续走 claims**（C2）。
  - 例外表 **RT 查，不折叠进 claims**（B5）。
- **不改变执行点**：PostgREST 行过滤仍读 claim（pgrst_pre_request 扁平化，迁移 114 机制复用）；新增 groups 过滤 + fields 掩码照 `perm.ts` 模板写法扩展。**双氧期内旧顶层 key 继续被 114 扁平，新旧 claim 段并存消费**（B6）。
- **catalog_v 校验（钉死）**：`catalog_v` = 代码/部署版本戳（部署/迁移时递增，非运行时自增计数）：只做「该具体 key 在 claims 内、但当前 catalog 已移除」的 **key 级按需 fail-close**（高下能力下架 + 旧 claims 引用该 key → 拒绝 + 提示重新登录）；**不做全局版本拒绝**（任一次 catalog 变更全员被锁 = 可用性事故）。判定方向 = `claim.catalog_v == server.catalog_v` **且** `每 key ∈ catalog ∪ deprecated` 双校验（回滚场景：代码回滚 → 版本戳降 → 高版本 claims 靠 key 存在性双校验兜底，不做序比较）。实查段以活查为准，`catalog_v` 仅离线快判/审计（判定序 = 与实查成 AND，禁止实现成 OR 绕过实查，F10）。
  - **快/慢路径防误读（redteam-lite M3.5）**：`==` **恒定真 → 跳过逐 key 校验（快路径）；否则逐 key ∈ catalog ∪ deprecated（慢路径）**——`==` 失败**不是拒绝条件**，只是降级到慢路径；实现把 `==` 当硬前置 = 任一 catalog 变更即全员锁死（可用性事故）。
  - **解析期校验（redteam-lite M2）**：请求具体 view K 时，claims 内通配（`view:*` 等）展开匹配后的**具体 key 仍须 ∈ catalog ∪ deprecated**，否则 fail-close——key 级 fail-close 从「claim 条目粒度」降为「解析结果粒度」，堵住「K 已被驱逐但持通配者照常可用」；这同时覆盖通配对下架能力的残余（见 §5.1 通配残余）。

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
- **环引用检测（S1）**：嵌套组 A→B→A 展开死循环 = 登录链路卡死。catalog 校验加环引用检测（红/绿测试：环引用 → 拒绝）。
- **成员变更生效粒度（S1）**：view-group 成员变更对已签发 claims 的生效粒度显式声明——batch-enforce 重建（挂 webhook 事件）或显式 7 天时效，二选一钉入实现；测试覆盖「成员变更 → 声明粒度内生效」。
- **view-group 成员禁含通配（M1）**：`view-group:*` 兜底下新增能力自动扩权不可控；成员只允许具名 `view:*` key。

### 5.6 变更传播（事件驱动，替代轮询）

- Casdoor webhook 事件（permission/role/group/user 变更）→ data-analysis web 端点收 → 缓存失效 + 写穿触发。
  - **payload 语义钉死（F3）**：Casdoor webhook payload = 请求体（maskPassword）+ 响应摘要，**非变更后全量对象**；接收端只当「失效信号」，数据一律以 re-pull / 对账为准（防 payload 假设）。
- 事件驱动为主 + 每日 3-way 对账兜底（08-15 §4.5 扩展：对象集从 roles 扩到 role/group/resource/catalog 四对象）。
- 不可达时退化为 TTL 自然过期（JWT 7 天；实查 5min）。
- **组变更 → 数据面即时失效（H16）**：D6 事件到达后对受影响 sub 的数据面 JWT 做即时失效（复用 `token_blacklist` by sub / claims 缓存清空），把「转岗/搬店/离组后旧门店数据可读」从 7 天缩短到分钟级；若实现上无法即时 → 显式接受 7 天窗口并加转岗对账（记录于残余风险）。

### 5.7 执行端消费（盘点收口，禁散落判断）

| 面 | 判定 | 数据源 |
|---|---|---|
| 页面可见（middleware） | `data-analysis:view:*` claims/catalog 校验 | 快判（软门禁） |
| admin 管理台 | `data-analysis:admin`（08-15） | requireAdmin + 实查兜底（裁决-1） |
| 报表行过滤 | `groups`+`data_scope.branch_nums` → RLS | PostgREST 行策略（复用） |
| 列掩码 | `fields.cost` → 整列 NULL | **非生成器运行时层消费**（H7） |
| push 广播/配置 | `push:broadcast`/`push:configure`（08-15 裸 key） | 引擎闸 + 实查 |
| 临时例外 | **temporary_grants RT 实查**（裁决-1 5min） | 授权中心 |

> **H7 列掩码消费位（redteam H4+H5）**：掩码禁止落在生成器模板内写死（现状 tier1.ts `maskCost`、hierarchy.ts 505-528 读 `request.jwt.claims.can_see_cost` 属技术债——基线做好准备、此处收口）：新增敏感字段 = catalog 加 `field:<slug>` + 掩码由**非生成器运行时层**（视图外包装/查询改写）消费，或把「生成器不动」改写为「生成器只接受 catalog 驱动输入」。`can_see_cost → fields.cost` 迁移时列消费点清单（生成模板 4 处 + push scope-signature + render），同一 PR 迁移 + 契约快照断言「无 fields 段 → 全掩」（安全方向不得依赖单处 CASE 不漏）。QA 断言扩为**衍生列血缘断言**（margin/rate 类全部随基列 NULL 传播，防 inner CTE 单独产出再外层投影漏掩）。

### 5.8 对账与回滚

- **3-way 对账 × 4 对象 + per-user 粒度（S4）**：Casdoor（role/group/resource/**permission.resources**）vs 本地（claims 声明/org_users 投影/catalog 期望）vs 期望集 → diff 分级（沿用 08-15 C/E/M 语义）+ 24h 未收敛页告警。**diff 输出 per-user 粒度（门店/品牌级）**——对象数粒度会掩盖个别用户缺失，与 CLAUDE.md「完整性按维度对账、禁全表数」精神一致；对象数仅作汇总头。对账对象明确含 **permission.resources vs catalog 差集**（判定基准 = Permission.resources 是真授权语义，resource 表是注册表，F11）；W1 就把该 diff 上线（不等到 W4 切行过滤）。
- **独立期望源（H10，防循环自证）**：组织挂组的「期望集」不得用 org_departments 投影（本 spec 已把它降级为 Group 树投影 = 期望源即被测对象）。建立独立于人机链的「人→门店」期望源（店长/督导岗位清单或考核分区清单，取自 claims/数据而非 Group 树），做**成员级差异对账** + `collect_fail` 告警；作为 W2 出口判据。
- **契约测试① sunset 替代（H11）**：08-15 契约测试①（Casdoor roles ⊆ data_permissions role subject_id ∪ {admin}）依赖的表在 W6 删除 → 同步定义替代契约（roles ⊆ Group tree + role_codes 差分期望集）并进 qa，标注为 sunset 替换项。
- **回滚**：catalog 回滚 = 代码回退 + 同步器反向（已从 resource 表移除的 key 保留标记 deprecated，**不 delete**——add-resource 原生 delete 挂 Storage provider，无 Storage 不可用，非删除式撤销与 deprecated 语义自洽，F2/F13）；Group 同步器删除 = 限自己建的组；例外表回滚 = 授权中心撤销。全部可脚本化（U6 一键 disable 模式复用）。

## 数据流

### 登录链路（本 spec 升级后，含 revision-2 勘误）

```
Casdoor OIDC → callback → 拉 roles(get-user) + 组读取(原生 token groups，
  开启 useGroupPathInToken = 全路径 claim；「get-user-groups」路由不存在，禁止调用；
  或 get-account 读 user.Groups)
  + 拉可达对象(get-all-objects → 过滤 data-analysis:* 子集 → permissions 平铺；
    push:* 保留裸 key，H4)
  + 门店叶子展开(groups → maps_branch_group → branch_nums；区域组=子孙叶子并集)
  → 三段任一失败 = 本次登录不产出门店范围(deny)或登录整体失败，禁空数组继续走 claims(C2)
  → 写穿镜像(role_codes/groups 投影, 只读消费) → 自签 JWT(catalog_v 版本戳)
  → claims → middleware / requireAdmin / PostgREST(行过滤+列掩码)
  例外：temporary_grants RT 实查（不折叠进 claims，B5）
```

### 新增能力上线流（动态发现）

```
路由/视图出现 → scan(cron 或 GHA) → catalog draft（只增不减，删除走人工废弃清单，H14）
  → 人工覆盖确认(可跳过, 用默认值) → 同步 adapter(加 "/" 前缀写入, 差集只插缺口, 幂等) 
  → Casdoor add-resource（撞 PK retry+吞 duplicate）→ resource 表就绪
  → 管理员勾角色(或 catalog 辅助页复制 key；通配授权列高风险清单)
  → claims 重建(登录/batch-enforce) → 校验器放行 + catalog_v 更新 → 生效
```

### Group 同步流（两通道分离 + 父链守护，H2/H1）

```
部门树：企微通讯录变更(webhook/03:17 全量) → upsert 部门组
门店树：对账 diff(dim_branch vs maps_branch_group vs Group 树) 驱动 upsert
  （门店对象企微没有，禁用企微 webhook 驱动；改名=新名 upsert+旧名摘挂/标 deprecated）
建树：先父后子（父链断裂 → 原生 GetUserFullGroupPath error → 整组登录崩）
  + 每日父链完整性校验 + 组树完整性指标(fail 告警)
  → 映射表写 maps_branch_group → 挂组 auto(企微 dept) + manual(人工; admin 自挂 store 叶子=高风险告警)
  → 每日对账(期望源=独立人→门店清单, 非 org_departments 自投影, H10) → 成员级 diff 分级告警
```

## 错误处理（降级策略）

| 故障点 | 方向 | 语义 |
|---|---|---|
| resource 同步失败 | outbox | 重放非丢弃（08-15 模式复用）；>48h 页级告警 |
| Group 同步失败 | outbox | 同上；挂组漂移由对账捕获 |
| 未知 resource key（校验器） | fail-close | 拒绝配置项 + 告警（反向发现） |
| 已删除/废弃 key 仍被 claims 引用 | **key 级 fail-close** | 该 key 判定拒绝 + 提示重新登录；**不做全局 catalog_v 版本拒绝**（H6） |
| catalog_v 与 server 不符（回滚场景） | 双校验 | `catalog_v == server` **且** 每 key ∈ catalog ∪ deprecated（M2/H6） |
| **半可达（OIDC 通、组读取超时）** | **fail-close deny**（C2） | 登录成功但 groups 段为空 → **本次登录不产出门店范围（deny）或登录整体失败**，禁止空数组继续走 claims；防空段落入全放 |
| maps_branch_group 缺失（门店未登记） | fail-close 单门店 | 该门店行不过滤降级为不可见 + 告警（不静默全放） |
| 用户无组（JIT 未挂/组被删/同步失败） | fail-close 空集 | claims 带 data_scope 空段 = ∅ deny，**不进 `["*"]`**（B1/铁律 6） |
| 父链断裂（ParentId 指向不存在组） | 前置拦截 | 原生 GetUserFullGroupPath error → JWT 签发失败；组同步器先父后子 + 每日父链校验 + 指标告警（H1） |
| Casdoor 不可达 | 继承裁决-2 | 存量会话 + 数据面零影响；新登录 <2-4h；实查 fail-close + 24h stale |
| 例外交互超时 | 降级 | 例外 RT 查失败 = 等同无例外（不 fold），审计记录 |

**残余风险（新增项，其余继承 08-15 R1-R8）**：

| # | 残余 | 理由 | 缓解 |
|---|---|---|---|
| R9 | 组织架构全量上收后 Casdoor 单点面扩大（目录+授权+范围） | IAM 主导的必然代价 | 缓存投影 + 断网口径 + 组同步器本地重放 + 对账盯漂移 |
| R10 | 组挂载继承依赖 Casdoor getRolesByUserInternal 行为（版本演进被改） | 不 fork 依赖上游 | 契约测试冻结「Group→Role 继承」行为（升级 V2 快照）+ 条目格式与 user.Groups 完全一致 |
| R11 | view-group 展开映射错配 → 授权面意外放大 | 派生对象 | catalog 校验（成员必须存在 + **环引用检测**）+ 对账 + 审计读权限对象时展开比对；成员禁通配 |
| R12 | 列级脱敏未来要值级（成本>X）时技术债残留 | V1 边界 | catalog 敏感标记为未来值级留字段位，不现在实现 |
| R13 | **转岗/搬店旧门店数据 7 天可读窗口**（若 H16 即时失效未落地） | JWT 7 天与 08-15 裁决-4 继承 | D6 webhook → blacklist 即时失效（首选）；无法即时则显式接受 + 转岗对账 |
| R14 | 组同步器父链断裂 → 整组登录崩（上游行为硬依赖） | ParentId 存 Name、GetUserFullGroupPath error | 先父后子 + 每日父链校验 + 完整性指标告警（W2 即启用，见 §5.3） |
| R15 | 例外 RT 实查引入本地读路径延迟/依赖 | 例外表在本地 DB | 行数极少 + 5min 缓存 + fail-close + 24h stale（裁决-1 机制复用） |

## 测试

（分层按 docs/testing-handbook.md §2；渗透清单 T1-T11 继承（08-15 至 T11，勘误），新增组目录类。**每条标 W 归属 + 首部红/绿**——测试先行纪律可审计，S5。）

- **[W1·红→绿]** catalog 校验器：合法 key / `*` / 未知 key 拒绝（单测红绿）
- **[W1·红]** 废弃 key（人工废弃清单）→ fail-close + 告警（H14）
- **[W1·绿]** 自动发现脚本：`新增路由/视图 → draft 新增行` **与** `catalog 移除 → draft 不进自动删`（两断言，S5）
- **[W1·红]** 通配授权（`view:*`）→ 进高风险清单提示（M1）
- **[W1·绿]** add-resource 同步器：幂等（重跑 no-op）；diff 空（对账 exit 0）；**name `/` 前缀归一前后一致性**（H3）
- **[W1·绿]** add-resource 并发/重复插入 → retry + 吞 duplicate（红→绿，双通道不撞 PK）
- **[W2·绿]** 组类型三态展开：门店叶子直映 / 区域组子孙叶子并集 / 部门组不展开 + 未知组类型 fail-close（H13）
- **[W2·绿]** 独立期望源「人→门店」成员级差异对账：注入错挂（门店映射到另一区域）→ 分级告警（H10，W2 退出判据配套）
- **[W2·红]** 父链断裂 → 完整性指标 fail + JWT 签发拒绝（H1）
- **[W2·绿]** Group 挂 Role 继承行为契约测试（冻结 R10，条目格式与 user.Groups 完全一致）
- **[W2·绿]** groups 投影（org_users.groups）写穿 → run_push/agent-query 无会话路径可读门店行（F9）
- **[W3·红]** claims 契约快照：新增 groups/data_scope/fields/catalog_v + **保留 08-15 八字段 + role_code/visible_panels（H5）+ push 裸 key（H4）**（V2 升级）
- **[W3·红]** permissions claim 迁移：四维维度 key → `data-analysis:*` 资源串（B2）后 admin 判定不再依赖 BREAKGLASS
- **[W3·红]** 双氧期：新 claims 含 data_scope 空段但保留顶层旧 key → RLS 不静默全放（B6/B1）；机制断言 = 策略分支红转绿：data_scope 存在（空段=deny）优先 / 缺失回退 legacy；顶层旧 key 写空数组/省略形态在 072 空数组→true 路径上的注入测试必须红转绿（M1）
- **[W3·红]** 空集 deny：data_scope 空数组 → 门店 0 行（不收敛 `["*"]`）（B1）
- **[W3·红]** 半可达降级：groups 拉取超时 → 登录不产门店范围（deny）或整体失败，非空数组进 claims（C2）
- **[W4·红]** 门店行过滤：挂组用户可见该门店行；未挂不可见；映射缺失 → 不可见+告警（伪造 claims 参数化，本地）
- **[W4·红]** 列掩码：fields.cost=false → 成本列 NULL；**衍生列血缘断言（margin/rate 全列随基列 NULL）**（H7）
- **[W4·红]** catalog_v：新 version 下持旧 version claims → key 级判定（有下线 key 拒、其余照常）；回滚场景 `==` + key∈catalog∪deprecated 双校验（H6）
- **[W4·红]** 存量授权回填：逐用户「claims 派生 scope vs 冻结快照」diff=0（白名单 + 非预期差异双清零）（B4/M1）
- **[W4·绿]** shadow 对账基线：**U2 冻结 legacy data_permissions 快照**、切换瞬间增量 diff=0（M2/B3）
- **[W4·绿]** 例外 5min 缓存实查：撤销后 ≤5min 生效（健康态；降级态 24h stale 上限仅限远端实查场景，B5/M3）+ 授权中心撤销同步清 sub 缓存 + RT→RLS 经 pgrst_pre_request 并集 claim（直连 SQL 通道同断言，M3）；到期不生效
- **[W4·红]** 例外交互 cap：无 `data-analysis:grant` → 403；超授额上限 → 拒绝（M4）
- **[W4·红]** view-group：环引用拒绝（红，S1）；成员变更按声明粒度生效（S1/S2 提前 observe 放量装 shadow 比对）
- **[W5·红]** DB 级写关闭：data_permissions 直写注入 → 拒绝（红转绿才放行；管理页只读只是 UX，H9/M4）
- **[W5·绿]** W5 写关闭前置：PERMS_INPUT=casdoor ≥24h 且 diff=0（F8）
- **[W5·绿]** 3-way 对账 × 4 对象 + per-user 粒度：注入差异 → 对应分级告警；per-user 缺失可辨（S4）
- **[W6·绿]** 契约①替代：roles ⊆ Group tree + role_codes 差分期望集（H11）
- **[W6·绿]** sunset：对账 7 天无 data_permissions 引用；167 回滚脚本演练留痕（M3 退出判据）
- **[W3-W6 全程·绿]** 迁移幂等：migrate.sh 重跑全绿（幂等模板）

## 实施阶段（W 轴并入 08-15 轨迹，不额外占主线窗口）

> 说明：标准化的收拢动作与已批准的推送/身份轨交织（U 轴照旧），W 轴利用 P0b/U1 浸泡期并行推进；WIP=1 纪律不变——W 轴的每个阶段仍是独立可合入的完整段。

> **每 W 给可测退出判据（H8/M3）**：只有 W1 有「就绪」行 → 无门禁则 sunset 可能在写入口未证实关闭、对账未证实收敛时过早执行，回滚窗口提前报废。下表中每 W 的「退出」为客观门禁，全绿才进下一 W。

```
W1  catalog + resource 同步 + 校验器（只登记不强制，默认 observe）
    就绪：scan/同步/校验三脚本绿；辅助页可看 synced 状态
    前置：org admin 级同步服务账号 + token 轮换就绪（F7，/api 每请求过 RBAC）
    退出：assert(scan 新增/删除两断言绿) ∧ sync 幂等 ∧ permission.resources-vs-catalog diff 已上线(无红)
W2  Group 同步器 + maps_branch_group + groups claim（先只写不读，影子对账）
    退出：影子对账 7 天白名单外 diff=0（人工挂组进白名单；白名单条目 = 人工审批 + 审计留痕）∧
          父链完整性指标 7 天 0 告警 ∧ 独立期望源「人→门店」成员级对账**收敛**——白名单外
          diff=0 连续 ≥7 天才算通过（H10/M4：只上线不算数；映射就绪态须与 072 语义核对后方可切）
          ∧ 分级红黄依据挂 08-15 C/E/M 定义（W1「无红」同引用）
W3  claims 契约扩展（data_scope/fields/catalog_v + permissions 资源串迁移 B2 + 双氧保留）+ catalog_v 版本戳
    ——与 U2 登录切换同一发布窗（避免双次登录链路改版）
    退出：契约快照测试全绿（含保留字段 H5、空集 deny B1、半可达 deny C2）；batch-enforce 重建**前后
          逐用户 claims 派生 scope diff=0**（授权 ∅ 用户除外；检测器 = 任一维缺失即报红，M4）；
          空集 deny 机制（RLS 策略分支）[W3·红]测试 红转绿（M1）∧ 旧形状令牌短 TTL ≤48h 生效
W4  存量授权回填 + 静态枚举 resource 化 + 消费侧切 + shadow 对账
    回填（B4/M1）：品牌/品类按角色或用户勾 Casdoor resource；门店集合批量挂组（批量推导 + 门店独立核对）；
      cost 例外进例外表（RT 实查）
    退出：回填后逐用户「claims 派生 scope vs 冻结快照」diff=0（白名单+非预期差异双清零）∧
          切行过滤影子对账基线 = U2 冻结 legacy 快照（M2/B3）、切换瞬间增量 diff=0（RT-6：快照到执行变动即作废重走）
          冻结机制（M4）= 不可变快照表（U2 时点 COPY）+ 冻结哨兵（表级标记防错基线）；W5 写关闭前
          残留写路径（refresh RPC 等，H9）对 live 表的写**仅告警、不入基线**——对账基线钉死用快照表
W5  例外表上线 + data_permissions DB 级写关闭（REVOKE/触发器 + 直写注入测试红转绿） + 管理页只读引导；
    授权组 view-group 转正放量（observe 期已在 W4 完成 shadow 比对，S2）
    退出：DB 禁写 + 直写注入拒绝测试绿 ∧ 7 天零缺口报告 ∧ 前置 = PERMS_INPUT=casdoor ≥24h 且 diff=0（F8）
W6  data_permissions 表删除（sunset，167 回滚脚本演练）+ 契约①替代（H11）+ 顶层旧 key 移除（双氧期结束 B6）
    退出：对账 7 天无 data_permissions 引用 ∧ 167 回滚演练留痕 ∧ 契约①替代绿
```

- W3 必须与 U2 同窗（登录链路只改一次）；其余各 W 可在 U 轴任意间隙落；**W5 ≥ U2 验收 + 回滚演练通过**（早于回滚窗口落地 → 秒回滚退化为只读 7 天期，F8）。
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
- `docs/ops/permission-boundary.md`：三者边界表新增「目录=Group tree」「数据范围三分流」，删「data_permissions 四维」表述，标注转移到 Casdoor/例外表；例外表补「RT 实查（非折叠）」语义（B5）。
- **写 CLAUDE.md（H12）**：catalog 单真相纪律 = 「`capabilityCatalog` 只存 `web/lib/capability-catalog.ts`，function 只消费不内嵌复制」——与生成器铁律同级；违反 = 违规（部署规则加注：function-only 部署不触发 catalog scan）。

---

程序性说明：本 spec 是 08-15 的标准化深化层，继承全部未提级接口与阶段；「修订声明」确保两份文档不打架；D1-D8 为用户 2026-08-16 原则批准记录在此，未单独逐条 gate。待用户评审后进入 writing-plans。
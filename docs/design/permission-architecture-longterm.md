# 平台级权限体系 · 长远架构方案

> 状态：提案（未评审）。不考虑工作量，只考虑「标准权限管理」的正确形态。
> 基线：2026-08 现状（Casdoor 上收真相源 + catalog 单真相 + claims 平铺 + RLS 数据兜底）。

---

## 0. 一句话结论

**从「Casdoor 托管 + 字符串通配 + 前端散判」演进为标准 PDP/PEP 分离的 RBAC+ABAC 混合模型**：
Casbin（Model=ABAC+RBAC with domains，Adapter=现有 PostgreSQL）做**裁决引擎（PDP）**，
catalog 做唯一 **PAP（策略管理点）**，`feature-perm.ts` 收口为唯一 **PEP（执行点）**，
数据安全继续由 PostgREST RLS 兜底（纵深防御第二层）。

---

## 1. 标准参考模型（为什么要这么分）

权限管理的工业标准是 NIST ABAC / XACML 提出的四角色分离：

```
PAP（策略管理点）──谁在管理权限、用什么界面
  │ 下发策略
PIP（策略信息点）──属性从哪来（用户部门、门店、角色、临时例外）
PDP（策略决策点）──enforce(sub, obj, act, env) → allow/deny
  │ 裁决结果
PEP（策略执行点）──每个受保护入口处强制执行（API 路由 / middleware / RLS）
```

对照现状的落差：

| 标准角色 | 现状 | 问题 |
|---|---|---|
| PAP | Casdoor 管理端（原始 UI）+ catalog 单真相 | 下拉展示名反查、`*` 空配置陷阱、无审批流 |
| PDP | **没有独立 PDP**——判定散在 JWT claims + `feature-perm.ts` 内嵌逻辑 | token 有效期内不可即时收权；判定语义（fail-open「未配置=全开」）藏在代码注释里 |
| PIP | Casdoor 用户/部门 + temporary_grants 表 | 三处数据源靠约定对齐，无统一属性视图 |
| PEP | middleware 软门禁 + requireAdmin + RLS | **fail-open 与 fail-close 并存**：`hasBoardPerm` 无 perms 时全开，`checkFeaturePerm` fail-close——语义不统一是长期最大隐患 |

---

## 2. 目标架构总览

```
┌───────────────────────── 管理面（PAP）─────────────────────────┐
│  自建权限管理页（替代 Casdoor 原始 UI）                          │
│  角色/组/能力勾选/临时例外/审批/审计 —— 全部走自建 API           │
│  能力 catalog（代码即真相）→ 自动同步 → Casdoor Resource        │
└──────────────┬────────────────────────────────────────────────┘
               │ 策略写入（幂等、带审计）
               ▼
┌───────────────────────── 裁决面（PDP）──────────────────────────┐
│  Casbin Enforcer（单实例服务 / web API 内嵌模块）                │
│  Model: RBAC + domains + keyMatch2 + 优先级 deny               │
│  Adapter: PostgreSQL casbin_rule 表（与业务同库）               │
│  输入: (sub=用户, dom=品牌, obj=能力key, act=read) + attr 上下文 │
│  缓存: enforce 结果 5min + 策略变更主动失效（watcher）           │
└──────────────┬────────────────────────────────────────────────┘
               │ allow / deny（含理由，供排障）
               ▼
┌───────────────────────── 执行面（PEP）──────────────────────────┐
│  ① web middleware：页面级（软门禁，重定向）                      │
│  ② API 路由 requireXxx：功能级（硬门禁，403）                    │
│  ③ PostgREST RLS：数据级行/列裁剪（兜底，防越权读数）            │
└────────────────────────────────────────────────────────────────┘
```

三层各自回答一个问题：
- **功能层**（PEP①②）：这个按钮/页面/接口你能不能用？
- **数据层**（PEP③）：你能看到哪些行哪些列？
- **裁决层**（PDP）：策略怎么说？（唯一真相，三层都问它）

---

## 3. 模型设计（Casbin Model）

### 3.1 为什么不直接用 Casdoor 内置 Casbin

Casdoor 的 Casbin 是**黑盒托管**：Model 固定（permission = roles × resources × actions）、
不支持 deny 优先、不支持环境属性（时间窗口/设备）、无法在我们的 API 里同步调用 enforce。
长远要「策略即数据、可版本、可测试、可解释」，必须自己持有一个 Enforcer。

### 3.2 目标 Model（`perm_model.conf`）

```ini
[request_definition]
r = sub, dom, obj, act

[policy_definition]
p = sub, dom, obj, act, eft

# 角色继承（用户→角色→组，域=品牌 3120/64188）
[role_definition]
g = _, _, _

[policy_effect]
e = priority(p.eft) || deny           # deny 优先 + 显式优先级

[matchers]
m = (g(r.sub, p.sub, r.dom) || r.sub == p.sub) && \
    (keyMatch2(r.obj, p.obj) || r.obj == p.obj) && \
    (regexMatch(r.act, p.act)) && \
    (p.dom == "*" || r.dom == p.dom)
```

要点：
- **`priority(p.eft) || deny`**：deny 永远赢——临时封禁、离职即时收权不再靠「删策略」实现，
  而是加一条高优先级 deny。这是现状做不到的最关键能力。
- **dom（域）= 品牌**：天然支持「某角色只在 3120 生效」，替代现在把品牌塞进 RLS 例外表的绕法。
- **keyMatch2**：`/views/:id` 风格通配，替代裸字符串 `data-analysis:view:*` 自制通配语义。
- 策略行即数据：可 diff、可 review、可回滚、可写断言测试（现在的「权限语义」散在
  `hasBoardPerm` 的注释里，不可测）。

### 3.3 策略来源映射（现状 → casbin_rule）

| 现状 | 目标 casbin_rule 行 |
|---|---|
| Casdoor role → permission.resources 勾选 | `p, role:店长, *, data-analysis:view:*, read, allow` |
| view-group（组挂载） | `g` 层：`group:报表全组` → 展开为成员（或保留组作为 RBAC 节点） |
| temporary_grants（≤90 天例外） | `p, user:xxx, dom, obj, read, allow` + TTL 列（适配器过滤已过期行） |
| 离职/封禁 | `p, user:xxx, *, *, *, deny`（priority 最高） |
| BREAKGLASS_ADMINS | 保留为环境级兜底（最后一道门），但每次触发告警 + 审计 |

### 3.4 判定语义统一（消灭 fail-open/fail-close 混用）

现状最大的语义债：`hasBoardPerm(undefined) → true`（「未配置=全开，避免上线即收权」）。
标准做法是**显式默认策略**而非隐式：

- catalog 里每个能力带 `defaultPolicy: allow | deny`（新能力上线默认 allow，`catalog_v` 升级时
  可批量收紧——收紧动作走变更审批，不是悄悄改代码）；
- PDP 对「用户无任何策略」返回显式 verdict：`allow(默认开放)` / `deny(默认关闭)` + reason；
- fail-open/fail-close 成为**模型配置项**而不是每个函数各自的注释。

---

## 4. PAP：管理面重构

### 4.1 自建权限管理页（替代 Casdoor 原始 UI）

Casdoor UI 的三类问题在本周已实际踩到：① 新建 permission 不勾资源 = `*`（全权限陷阱）；
② 下拉显示的是映射名/展示名，需要 `DISPLAY_NAME_TO_KEY` 反查归一；③ 禁字符（`:/?&#`）
迫使 key 做双向映射。长远应**把 Casdoor 降级为纯 IdP（认证）**，授权管理全走自建：

```
/admin/permissions
  ├─ 角色管理：角色 ←→ 能力勾选（树形，按 catalog 组分层）
  ├─ 用户查询：某用户 → 生效权限全景（角色∪组∪例外，含来源标注）
  ├─ 临时例外：现 GrantsTab 保留（带 TTL）
  ├─ 变更审批：权限变更 → 二次确认 / 双人审批（高危角色）
  └─ 审计流：现 AuditPanel 保留 + 决策日志（见 §7）
```

写路径统一为一个 API：`POST /api/admin/perm-policy`，服务端负责：
1. 校验 obj ∈ catalog（E-unknown 在写入口就挡，而不是事后对账红区）；
2. 校验通配风险（`validateWildcardRisk` 前置为写时校验）；
3. 幂等写 casbin_rule + 审计 + **watcher 通知所有 Enforcer 失效缓存**（即时生效，不等下次登录）。

### 4.2 资源注册（能力目录）保持现状骨架，补三点

- **schema 化**：catalog 从 ts 文件升级为带 JSON Schema 的版本化清单
  （`catalog_version` 已有 `CATALOG_V`，补 `defaultPolicy`、`riskLevel`、`owner` 字段）；
- **禁字符问题消失**：自建 PAP 后 key 不再进 Casdoor resource 表，`:` 映射层整体删除；
- **对账方向反转**：现在是「事后对账红区」，长远是「写时校验 + 定时对账仅作回归探测」。

---

## 5. PDP：Enforcer 部署形态

阶段演进（不求一步到位）：

1. **内嵌模式**：web API 路由内直接 `newEnforcer(model, pgAdapter)`，
   `checkFeaturePerm` 内部改调 `enforcer.enforce()`——接口签名不变，全站零改动切换；
2. **watcher**：策略表变更 → PostgreSQL LISTEN/NOTIFY（或 pub/sub）→ 各实例
   `enforcer.loadPolicy()` 热更新——撤销即时生效（≤秒级），替代现在「等 token 过期」；
3. **独立服务（可选终态）**：权限裁决 QPS 高或需要跨服务（push 引擎、edge functions 也问权限）时，
   拆出 `perm-pdp` 服务，gRPC/HTTP enforce + 批量 `BatchEnforce`。

### 5.1 性能与缓存策略

- 策略行预计 < 10⁴（角色×能力），全量常驻内存，enforce 是 O(策略数) 字符串匹配，微秒级；
- 用户级结果缓存 5min + 变更主动失效（保留现有 5min 缓存纪律，加上失效通道）；
- JWT claims 不再承载授权真相，只承载身份（sub）+ `catalog_v`——token 变薄，
  「改权限要等重新登录」这个约束彻底消失。

---

## 6. PEP：执行点统一纪律

```ts
// 全站唯一权限执行点（feature-perm.ts 收口不变，内部换 PDP）
const v = await checkFeaturePerm(userId, 'data-analysis:view-board:kpi', { dom: brandId });
if (!v.allow) return res403(v.reason);   // reason 供排障 & 审计
```

- middleware / requireAdmin / RLS 三层全部改为问 PDP（RLS 的行级范围仍用
  JWT 注入的 `branch_nums/brands` claims——数据范围属性可以继续折叠进 token，
  因为行级裁剪每请求实查代价高；但**功能裁决不再信 token**）；
- 删除散落的 `*` 字符串比较（`permissions.includes('*')` 类逻辑全部进 PDP matcher）。

---

## 7. 审计与可观测

三层日志：

1. **变更审计**（已有）：谁在何时改了什么策略——保留现有 audit 表；
2. **决策日志**（新增）：PDP 每次 deny 记 `(sub, obj, reason, traceId)`，
   采样率可配——出问题能回答「为什么这个人看不到这个看板」；
3. **定期对账**（保留但降级为回归探测）：catalog vs 策略表 vs 生效快照，
   红区只该抓「漂移」，不该抓「配置中间态」。

`/admin/capabilities` 能力页转型为**权限健康中心**：通配风险面、deny 策略占比、
无策略用户数、例外到期日历——从「对账排错页」变成「治理仪表盘」。

---

## 8. 生命周期与治理

| 生命周期 | 机制 |
|---|---|
| 能力新增 | catalog PR（code review 即权限 review）→ CATALOG_V++ → 自动可配 |
| 能力废弃 | catalog 移入 DEPRECATED → 对账提示持有者 → 清零后删除（现状流程保留，写时校验让它不会复发） |
| 人员入职 | 企微同步 → 部门映射默认角色（PIP） |
| 人员转岗 | 改角色指派（即时生效，不等重新登录） |
| 人员离职 | offboard-check 加高优 deny + 吊销 token（现有 sink① 逻辑升级） |
| 高危授权 | `riskLevel=high` 的能力勾选需双人审批 |
| 应急 | BREAKGLASS 保留，但触发即告警 + 24h 自动过期 |

---

## 9. 演进路线（依赖排序，非排期）

```
Phase 0（已完成）  Casdoor 上收真相源 + catalog 单真相 + 例外通道 RLS 实查
Phase 1  判定语义统一：显式 defaultPolicy，消灭 fail-open 注释魔咒
Phase 2  引入 casbin + PG adapter，checkFeaturePerm 内部切换（PEP 签名不变）
Phase 3  watcher 即时失效 + token 减负（claims 不再载授权真相）
Phase 4  自建 PAP 管理页，Casdoor 降级为纯 IdP，删映射层
Phase 5  deny 优先级策略（离职 deny、临时封禁）+ 决策日志 + 治理仪表盘
Phase 6（可选）PDP 独立服务，覆盖 push 引擎 / edge functions
```

每个 Phase 独立可回滚（casbin_rule 表与 Casdoor permission 双写并行期，
读切换后 Casdoor 侧只读保留一个对账周期再退役）。

---

## 10. 明确不做的（防过度设计）

- 不引 XACML/PDP 网关类重型中间件——Casbin 已覆盖，标准四角色用模块实现而非新系统；
- 不做 ABAC 属性引擎的全动态化——属性仅限：品牌域、门店范围、时间窗、用户状态四个，
  其余仍走 RBAC（角色）表达，可解释性优先；
- 数据级行/列裁剪不搬进 PDP——RLS 是数据层的正确工具，PDP 只管「功能/资源」粒度。

# 权限三层架构设计（身份 / 功能授权 / 数据范围 分层收敛）

> 状态：设计待审 · 2026-08-15
> 范围：把散落三处的数据权限收敛为单一 scope 映射表 + 统一 resolver；引入 Casdoor Permission 承担功能授权层；RLS/视图过滤执行点零改动。为推送平台（[[2026-08-15-novu-push-platform-design]]）和"人人 AI 配置"提供权限地基。
> 关联：[[2026-08-08-casdoor-wecom-sso-design]]、[[2026-08-09-casdoor-independent-design]]（身份层已就位）

---

## 1. 背景与问题

### 1.1 现状：权限散落五处

| 位置 | 管什么 | 问题 |
|---|---|---|
| `ADMIN_USERIDS`（web/lib/auth.ts） | admin 白名单 | 硬编码，改名单要发版 |
| `org_departments.branch_nums/can_see_cost` | 部门级数据范围 | 部门并集语义，个人无法单独微调 |
| `retail_query_user_perms` | 按人 override（优先于部门） | 与部门制并存，两套优先级逻辑 |
| PG RLS + 生成器模板 `claim_match_or_star` | 行级/列级执行 | **执行点，正确且不动** |
| Casdoor（sso.shanhaiyiguo.com） | 身份（wecom_id）+ SSO | 已独立，但只管身份不管授权 |

### 1.2 结论性事实（2026-08-15 源码验证，源码分析/ 目录）

- **Casdoor 内置 Casbin**（`casdoor/go.mod`: `casbin/v2 v2.77.2`），Permission 模型 = 主体(Users/Groups/Roles/Domains) × 资源(ResourceType+Resources) × 动作(Actions) × Effect，带过期/审批字段，管理 UI 现成（`object/permission.go`）。**无需单独引入 casbin 服务**——Casdoor 权限层就是带 UI 的 casbin。
- casbin/Casdoor 都**不能做行级数据过滤**（无 policy→SQL；casbin 是单次判定引擎）。数据范围（branch_nums/brands/can_see_cost）必须留在本地表 + claims + RLS。

## 2. 目标架构（三层）

```
① 身份层（不动）：Casdoor OIDC → wecom_id
② 功能授权层（新增使用）：Casdoor Roles + Permissions
    Roles: ceo / war-zone-head / region-supervisor / admin / member ...
    Permissions: 角色 × 资源(版块:功能:动作) × Effect
    —— 菜单可见性、API 入口、推送配置权限、admin 白名单全部迁这里
③ 数据范围层（收敛）：本地统一 scope 表 → 唯一 resolver → claims → RLS/视图过滤（执行点零改动）
```

**职责铁律**：Casdoor 只答"谁是战区总"；本地 scope 表只答"战区总=哪些店"。业务数据范围（branch_nums 等）永不进 IdP。

## 3. 详细设计

### 3.1 统一 scope 映射表（新迁移）

```sql
CREATE TABLE data_scopes (
  id SERIAL PRIMARY KEY,
  subject_type VARCHAR(10) NOT NULL,      -- 'user' | 'role' | 'department'
  subject_id TEXT NOT NULL,               -- wecom_id / role_code / dept_id
  brands TEXT[] DEFAULT NULL,             -- NULL/'*' = 全品牌
  war_zones TEXT[] DEFAULT NULL,          -- dim_war_zone.war_zone
  regions TEXT[] DEFAULT NULL,            -- dim_region.region_name
  branch_nums TEXT[] DEFAULT NULL,        -- 兜底门店清单（品牌内编号）
  can_see_cost BOOLEAN NOT NULL DEFAULT FALSE,
  priority INT NOT NULL DEFAULT 0,        -- 解析优先级：user > role > department
  is_active BOOLEAN DEFAULT TRUE,
  UNIQUE (subject_type, subject_id)
);
```

- **解析规则（唯一 resolver `resolve_scope(wecom_id)`）**：取用户 → 按优先级找第一条命中（user 直配 > 其角色 > 其部门），未命中 = 无数据权限（空 scope）。
- 现有三处数据迁移：`retail_query_user_perms` → subject_type='user' 行；`org_departments.branch_nums/can_see_cost` → 'department' 行；`ADMIN_USERIDS` 不迁数据（改走 Casdoor Permission），代码内白名单保留为启动期兜底。
- **claims 结构不变**：resolver 产出 `{brands, branch_nums, can_see_cost}` 填入自签 PostgREST JWT，RLS/生成器视图/契约测试零改动。
- 兼容期：resolver 先按"新表优先、旧表回退"双读，`get_user_perms` 内部切换，调用方（agent-query、wecom-oidc-callback、渲染引擎）无感；双轨验证一致后旧表降级为只读归档。

### 3.2 Casdoor Permission 接入

- 每个系统注册为资源命名空间：`data-analysis:report-center:read`、`data-analysis:push:configure`、`openwiki:kb:edit` ...
- 角色→资源在 Casdoor UI 配置（改权限不发版）。
- **落地路径**：① web 端登录后从 Casdoor token 拉 roles（需验证 token roles claim 配置）或调 Casdoor API 查 Permission，写进会话；② 前端菜单/`/admin/*` 门禁从 roles 映射（契约单源 `web/lib/contracts`）；③ API Route 的 admin 校验改为查"当前用户对 `data-analysis:admin` 资源是否有权限"。
- 新版块接入清单（入 `web/lib/contracts`）：注册 Casdoor 资源 + 授权角色 → 复用 OIDC client + claims 签发器 + middleware。

### 3.3 推送授权规则（消费方之一，详见 Novu spec）

- 配置者只能向 **自己 scope 内** 的收件人组推送；
- 模板只能引用 `min_required_scope ⊆ 配置者 scope` 的变量（`push_variables` 注册）；
- 全员范围推送需 admin 资源确认。

## 4. 实施步骤

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | `data_scopes` 迁移 + resolver + 双读兼容 | `get_user_perms` 新旧结果对账一致（SQL diff = 0） |
| P2 | claims 签发切到 resolver | 登录后 RLS 行为回归（现有报表权限不变） |
| P3 | Casdoor 建 Roles/Permissions + web 菜单门禁接入 | admin 白名单发版解耦；菜单按角色出 |
| P4 | 旧三处降级只读归档 | 无调用方引用旧表 |

## 5. 非目标

- 不改 RLS 策略、生成器模板注入、DuckDB 权限视图（执行点已验证可靠）。
- 不引入独立 casbin 服务（Casdoor 已含）。
- 不做多企业 org（Casdoor 架构就绪，按需后启）。
- 不动 Casdoor 身份层（2026-08-08/09 已定案）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| Casdoor token 不带 roles claim | 回退：web 服务端调 Casdoor API 查 Permission（登录时一次，缓存会话） |
| scope 迁移漏行 | P1 双读对账门禁：新表结果 ⊇ 旧表并集才切 |
| 授权粒度爆炸 | 资源只到 版块:功能:动作 三段，不做行级（行级归 scope 层） |

# 权限体系重构设计（data_permissions 单表授权 + 逐维合成 + 管理面产品化）

日期：2026-08-13
状态：已获用户逐节确认（方案 A + 逐维叠加/覆盖规则 + 部门层保持两维 + 范围锁定）
来源：issue #2「对权限体系重构」（GitHub `MYTech-Co-LTD/data-analysis#2`）
关联：[[2026-08-03-report-permission-lockdown-design]]（上一轮权限收口）、`docs/architecture.md` §6.2（RLS/权限表）、§6.1（身份层 Casdoor 分层）

---

## 1. 背景与动机

issue #2 body 为空，经澄清确认重构动机为「接入统一身份平台 + 产品化管理（去 SQL）」。范围限定后，重构 = 两块：

1. **数据模型统一**：把散在 3 处的授权数据（`org_departments.branch_nums/can_see_cost` 权限列、`data_permissions`、遗留 `retail_query_user_perms`）收编为**一张授权表** + **一条合并逻辑**。
2. **管理面全产品化**：部门门店范围/成本开关、个人 override、临时授权、角色参数全部页面化，杜绝手工 SQL；新增变更审计。

「接入统一身份平台」的落位：身份层已在 Casdoor（§6.1 分层：Casdoor 管身份/wecom_id/SSO，data-analysis 拿 wecom_id 后自签 PostgREST JWT）。本轮把**数据权限治理层**（模型 + 管理面）对齐平台方向做产品化；**不做 Casdoor 深度联动**（详见 §6 边界）。

### 现状痛点

- 授权数据分三处：部门权限在 `org_departments` 权限列（手工 SQL 维护），角色/个人 override 在 `data_permissions`，老按人授权还躺在 `retail_query_user_perms`（已 REVOKE 写、未 DROP）。
- `get_user_perms` 从多张表凑结果（016 开始迭代的历史实现）：有个人 override → **四维整包替换**（想收窄做不到：个人只能开 3 家店但部门是全部门 30 家 → 整包换也换不掉部门贡献；想只改一维必须连带维护其它三维）。
- 无变更审计，谁改了什么不可查。

---

## 2. 已确认决策

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 整体方案 | **方案 A**：单表授权 + 全页产品化。JWT claims / RLS / 生成器 / 登录流零改动 |
| D2 | 部门层授权维度 | **保持两维**（`branch_nums` + `can_see_cost`）；`brands`/`categories` 仍只由角色/个人 override 层配置 |
| D3 | 合成规则 | **逐维度独立合成**：基底 = 角色 ∪ 部门叠加（并集）→ 个人 override 某维「配了」则覆盖该维，「未配（NULL）」则该维继承基底 |
| D4 | 范围 | ① 数据模型统一 + ② 管理面全产品化；**不含** 20 个零鉴权 admin 路由收口、perms 兜底改拒绝、Casdoor 深度联动 |
| D5 | 授权表语义 | `data_permissions` 各维 `NULL` = 该维未配置（不参与）；空数组/含 `*` 兜底语义不变 |

---

## 3. 数据模型设计

### 3.1 data_permissions：唯一授权表

`data_permissions`（072 已建）成为唯一授权表，语义微调：

- 各维列 DEFAULT 由 `'["*"]'` 改为 `NULL`；`NULL` = 该行不参与这一维的合成。
  - 范围维：`branch_nums` / `brands` / `categories`（JSONB 数组，`["*"]` = 全放行）
  - 开关维：`can_see_cost`（BOOLEAN）
  - 行级：`subject_type`（`role`/`dept`/`user`）、`subject_id`（role_id::text / dept_id / wecom_id）、`expires_at`（临时授权，NULL=永久）、`note`
- 现有 role 行四维均有显式值，不受 DEFAULT 变更影响。
- 行贡献规则：
  - **role 行**：四维全可配（具名授权包 + UI 档案）
  - **dept 行**：只配 `branch_nums` + `can_see_cost` 两维，`brands`/`categories` 恒 NULL
  - **user 行**：四维按需配（只配要覆盖的维），支持 `expires_at`

### 3.2 迁移步骤（单个幂等迁移）

生产执行前先跑只读核对 SQL（`org_departments` 权限列实际值、`retail_query_user_perms` 行数、现有 `data_permissions` dept/user 行是否为空），确认后正式迁移（migrate.sh ON_ERROR_STOP=1，幂等模板，任一步错即整体回滚）：

1. `ALTER TABLE data_permissions ALTER COLUMN branch_nums/brands/categories SET DEFAULT NULL; ALTER COLUMN can_see_cost SET DEFAULT NULL;`（现有数据不动）
2. **部门权限迁入**：`INSERT ... SELECT 'dept', d.id::text, d.branch_nums, NULL, NULL, d.can_see_cost, ...` FROM `org_departments d WHERE d.is_active`；`note='迁移自org_departments'`；幂等：按 dept 行（未存在）插入，重跑 no-op
   - 处理已存在的 dept 行（理论上无，防御）：以 org_departments 为准 UPDATE
3. **老按人表迁入**：`retail_query_user_perms` 每行 → `data_permissions(subject_type='user', note='迁移自retail_query_user_perms')`（幂等同 ↑）；随后 `DROP TABLE retail_query_user_perms;`
4. `ALTER TABLE org_departments DROP COLUMN IF EXISTS branch_nums, DROP COLUMN IF EXISTS can_see_cost;`（引用已清：仅 get_user_perms + preview 路由，均本轮改写；wecom-sync-contacts 只写部门基础字段）
5. `CREATE TABLE IF NOT EXISTS permission_audit ...`（见 §4.4）
6. **重写 `get_user_perms`**（`CREATE OR REPLACE`，签名 `VARCHAR`→`JSONB` 与返回结构**一字不动**，见 §3.3）
7. 部署后 `docker compose restart postgrest` 刷 schema 缓存（铁律）

### 3.3 get_user_perms 重写：逐维合成

```
对每个范围维 ∈ {branch_nums, brands, categories}:
  基底    = dedup_union( ROLE行该维,  DEPT行该维 )   -- 忽略 NULL；含 "*" 即全放行
  结果    = 个人user行的该维非 NULL ? 个人该维 : 基底

can_see_cost:
  结果    = 个人user行 cost 非 NULL ? 个人cost : ( ROLE行 OR DEPT行 任一 true )

聚合时对所有 subject 行统一过滤已过期条目：
  (expires_at IS NULL OR expires_at > NOW())
  -- role 行种子无过期；dept 行沿用 expires_at=NULL（永久），不提供到期 UI；user 行支持 expires_at

兜底（零爆炸半径，保留现状）:
  - 用户不存在 / is_active=false          → 全 ["*"] 放行，role_code=null
  - 结果范围内含 "*"                       → 收敛为 ["*"]
  - 结果维度空数组                         → 兜底 ["*"]
```

返回 JSON 结构不变：`{role_code, branch_nums, brands, categories, can_see_cost, default_landing, default_metric, visible_panels}`。

→ **消费端零改动**：`wecom-oidc-callback` 签 JWT（claims 组装逻辑不动）、RLS（`claim_match_or_star` 策略不动）、生成器 `perm.ts` 注入不动、`deploy` 不动。

### 3.4 roles 表保留

`roles` = UI 档案（`default_landing`/`default_metric`/`visible_panels`/`is_active`）+ 具名授权包（data_permissions role 行）。用户无 role_id = 无 UI 档案，数据维度只剩部门基底 + 个人 override。`dept_role_mapping` 同步自动赋值链路（152 `refresh_role_assignments`）不变。

---

## 4. 管理面（API + 前端 + 审计）

### 4.1 API 路由（全部 `requireAdmin`，既有 `web/lib/admin-api-auth.ts`；直连 PostgREST service key，同现模式）

| 路由 | 方法 | 职责 |
|---|---|---|
| `/api/admin/permissions/users` | GET（改） | 用户列表 + 角色 + 部门（部门权限改从 data_permissions 聚合展示） |
| `/api/admin/permissions/users` | PUT（留） | 角色指派（manual，`role_source` 语义不变） |
| `/api/admin/permissions/users/:wecom_id` | GET / PUT / DELETE（新） | 个人 override 行：四维 + `expires_at` + `note`；DELETE = 删行恢复继承 |
| `/api/admin/permissions/depts` | GET（新） | 部门列表 + 门店范围/成本 + `dept_role_mapping` 自动角色 |
| `/api/admin/permissions/depts` | PUT（新） | 写部门 `branch_nums`/`can_see_cost`（upsert dept 行；brands/categories 恒 NULL） |
| `/api/admin/permissions/roles` | GET（新） | 角色参数 + 角色级默认 data_permissions 行 |
| `/api/admin/permissions/roles/:id` | PUT（新） | 改角色参数 或 角色默认范围四维 |
| `/api/admin/permissions/audit` | GET（新） | 最近变更（分页，倒序） |
| `/api/admin/permissions/preview` | GET（改） | 生效预览（dept 权限改读 data_permissions 行，展示不变） |

### 4.2 写路径：一次保存 = 写表 + 写审计

```sql
-- 保存部门门店范围（upsert dept 行）
INSERT INTO data_permissions (subject_type, subject_id, branch_nums, can_see_cost, note)
VALUES ('dept', '<dept_id>', '["54","127"]', false, '部门tab修改')
ON CONFLICT (id) DO UPDATE SET branch_nums=EXCLUDED.branch_nums, can_see_cost=EXCLUDED.can_see_cost, ...;

-- 审计
INSERT INTO permission_audit (actor_wecom_id, actor_name, action,
                              subject_type, subject_id, payload_before, payload_after)
VALUES ('ZhangDuo', '张朵', 'upsert_data_permission', 'dept', '<dept_id>', '<前值>', '<后值>');
```

**清空语义（收紧点）**：
- 个人 override：DELETE 行 = 完全恢复「角色∪部门」继承（收回单独授权的标准动作）
- 部门行：永远 upsert（全默认 `["*"]` + cost false ≈ 无补充），不做 delete 路径

**失败一致性**：写库失败 → 返回错误、**不写审计**（API 层先写权限表、成功后再写审计）；审计写失败仅记 error 日志、不阻断主操作返回。

### 4.3 前端 /admin/permissions（重组）

```
/admin/permissions
├─ Tab 用户：角色指派（保留 manual 语义） + 个人 override 编辑器（四维+到期+note+删除恢复继承） + 生效预览
├─ Tab 部门：门店范围选择器（品牌感知 + 按战区/区域分组 + 搜索）+ 成本开关 + 自动角色（dept_role_mapping）
├─ Tab 角色：角色参数（落地页/默认指标/可见面板/is_active）+ 角色默认范围四维
└─ 审计区：permission_audit 最近变更（操作者/主体/动作/前后值摘要）
```

- **门店选择器**：数据源复用 `/api/admin/branches`（dim_branch），按品牌（3120/64188）分隔 + 战区（东/南/西/中）+ 二级区域分组勾选。
- **门店键铁律提示条**：门店号跨品牌重复；选择器按品牌分组仅为便于勾选，勾选结果存 `branch_nums`（brands 仍由角色/个人层决定；RLS 是 `(brands? sbc) AND (branch_nums? n)` 双重过滤，跨品牌同号不冲突）。
- **生效时机**：权限改动后用户下次登录（重新签 JWT）生效，页面注明。
- 视觉遵守 DESIGN.md（DM Sans + tabular-nums + Industrial/Utilitarian）。

### 4.4 permission_audit 表

```sql
CREATE TABLE IF NOT EXISTS permission_audit (
  id             SERIAL PRIMARY KEY,
  actor_wecom_id TEXT NOT NULL,        -- 操作者（来自登录 cookie JWT sub）
  actor_name     TEXT,
  action         TEXT NOT NULL,        -- assign_role / upsert_data_permission / delete_data_permission / update_role
  subject_type   TEXT NOT NULL,        -- user / dept / role
  subject_id     TEXT,
  payload_before JSONB,
  payload_after  JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
```

> 审计只覆盖**页面变更**（API 写入时一并落审计）；SQL 直改绕不过——运维文档注明「权限变更一律走权限管理页」。审计表无 RLS（同 data_permissions，仅 service key / admin 通路）。

---

## 5. 灰度与验证

### 灰度（每步可独立回滚）

1. 数据收编 + `get_user_perms` 重写（迁移 + 函数替换）。部署后**行为应与现状等价值**：无 override 用户 = role∪dept 并集（与旧逻辑同）；有 override 用户旧逻辑整包换、新逻辑逐维覆盖——生产上这类用户极少且通常四维全填，大概率等价。先验证再往下走。
2. 管理 API + 前端三 tab 上线。
3. 部门范围实际收窄 = 权限管理员后续用新页面的运维行为，不在本轮必做。

### 验证手段

- 迁移幂等重跑（migrate.sh 模板）；重跑后 restart postgrest
- **get_user_perms 前后 diff**：dev/staging 迁移前先跑，对抽样用户（重点：无 override 用户必须一致）对比新旧函数输出
- 自签 JWT 直连 PostgREST（容器 IP，绕过网关）验 RLS 裁行与脱敏，覆盖三种 token：无 claim / `["*"]` / 收窄后
- 报表页抽查（达成看板、品牌指标、品类汇总、批发、供应链出库、商品下钻）
- 前端走查：三 tab CRUD、门店选择器（品牌/战区）、个人 override 语义（维留空继承、DELETE 恢复）、审计、预览

---

## 6. 错误处理与边界

### 错误处理

- `get_user_perms` 失败兜底保持现状：全放行（零爆炸半径，保登录可用性）；失败告警另开轮
- 管理 API 鉴权失败返 401/403，不泄露权限数据
- 保存写库失败返错误且不落审计；审计写失败降级为日志
- 迁移 ON_ERROR_STOP 整体回滚

### 明确不做（本轮）

1. 20 个零鉴权 `/api/admin/*` 路由收口（另开轮）
2. perms 失败兜底从「放行」改「拒绝」
3. **Casdoor 深度联动**：用户/角色同步进 Casdoor、按 org 隔离数据权限、权限管理员角色化——不做；Casdoor 身份层已就位（§6.1），本轮是数据权限治理层产品化对齐
4. 部门 branch_nums 实际收窄（交付工具；收窄是权限管理员运维行为）
5. 权限实时刷新（重新登录生效）
6. `data_permissions`/`permission_audit` 加 RLS（保持 service key + SECURITY DEFINER 通路）

---

## 7. 涉及改动面

| 层 | 内容 |
|---|---|
| 架构文档 | `docs/architecture.md` §6.2 权限表描述：data_permissions 唯一授权表 + 逐维合成规则 + permission_audit；生成器约束节不变 |
| 数据库 | 1 个幂等迁移：DEFAULT 改 NULL、部门/老按人行迁入、DROP 两列 + `retail_query_user_perms`、建 `permission_audit`、重写 `get_user_perms` |
| function | 无（`wecom-sync-contacts` 不写权限列；`wecom-oidc-callback` 零改动） |
| web API | `/api/admin/permissions/*`：users（改）、preview（改）、users/:wecom_id（新）、depts（新）、roles（新）、audit（新） |
| web 前端 | `/admin/permissions` page.tsx 重组三 tab + 门店选择器 + 审计区 |
| 运维 | 运维文档：权限变更一律走页面；迁移前后只读核对 SQL |
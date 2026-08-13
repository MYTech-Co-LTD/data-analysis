# 权限体系重构实施计划（data_permissions 单表授权 + 逐维合成 + 管理面产品化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **本项目用户已指定：plan 完成后用 orca 编排多 agent 开发，并用不同 agent review（见末尾「执行编排」节）。**

**Goal:** 把散在三处的授权数据收编为 `data_permissions` 单表授权，`get_user_perms` 改为逐维叠加+覆盖合成，权限管理面全页面化并带变更审计。

**Architecture:** 数据层两个动作——① 部门/老按人授权数据迁入 `data_permissions`（`subject_type='dept'/'user'`）后 DROP 老载体；② `get_user_perms` 重写为「角色∪部门基底叠加（并集）+ 个人 override 按字段覆盖（NULL=不覆盖）」的逐维合成，返回结构一字不动。管理面在既有 `/api/admin/permissions/*` + `requireAdmin` 模式上扩路由（users 改、users/:wecom_id、depts、roles、audit 新），前端 `/admin/permissions` 重组为三 tab。**消费端（JWT claims、RLS、生成器 perm.ts、登录流）零改动。**

**Tech Stack:** PostgreSQL（幂等迁移 + PL/pgSQL SECURITY DEFINER 函数）、Next.js App Router（API route + 前端页）、vitest（路由单测）、PostgREST（service-key 直连写）。

## Global Constraints

- 迁移文件幂等模板（`DROP ... IF EXISTS` + `ON CONFLICT`）；`migrate.sh` 会重跑全部迁移，视图必须 `DROP VIEW IF EXISTS + CREATE VIEW`
- **门店键铁律**：`branch_num` 跨账套重复，最终过滤永远 `(brands? sbc) AND (branch_nums? n)` 组合，选择器按品牌分组仅为勾选便利，存储仍只写 `branch_nums`
- **零爆炸半径**：`get_user_perms` 兜底保持「claim 缺失/含 `"*"` → 放行；用户不存在 → 全 `["*"]`」
- 改表/加列/新建路由后 `docker compose restart postgrest` 刷 schema 缓存
- `requireAdmin`（`web/lib/admin-api-auth.ts`）从 cookie `insforge_access_token` + `wecom_userid` 鉴权；所有新 API 路由第一行调用它
- 外部系统数据字段用 TEXT；自己控制的枚举用 VARCHAR
- 权限变更一律走页面（写库 + 落审计）；SQL 直改绕不过审计，运维文档注明

---

## 文件结构

```
database/migrations/167_permission_consolidation.sql   [Task 1] 建模：DEFAULT NULL、收编、DROP、审计表、get_user_perms 重写
database/scripts/verify_permission_consolidation.sql   [Task 1] 行为验证：构造冒烟数据 + 逐维规则断言（可留作回归）
web/app/api/admin/permissions/users/route.ts           [Task 2] 改：用户+角色+部门列表（dept 权限改聚合 data_permissions）
web/app/api/admin/permissions/preview/route.ts         [Task 2] 改：dept 权限读 data_permissions
web/app/api/admin/permissions/users/[wecom_id]/route.ts [Task 2] 新：个人 override GET/PUT/DELETE
web/app/api/admin/permissions/depts/route.ts            [Task 2] 新：部门列表 GET + 写部门权限 PUT
web/app/api/admin/permissions/roles/route.ts            [Task 2] 新：角色列表 GET
web/app/api/admin/permissions/roles/[id]/route.ts       [Task 2] 新：写角色参数+默认范围 PUT
web/app/api/admin/permissions/audit/route.ts            [Task 2] 新：审计列表 GET
web/app/api/admin/permissions/**/__tests__/*.test.ts    [Task 2] 路由单测（vitest，mock fetch）
web/app/admin/permissions/page.tsx                       [Task 3] 重组：三 tab + StorePicker + override 编辑器 + 审计区
docs/architecture.md (§6.2)                             [Task 4] 权限表描述更新
docs/ops/permission-maintenance.md                      [Task 4] 运维手册改为「页面操作 + 核对 SQL」
```

---

## Task 1: 数据模型收编 + get_user_perms 逐维合成 + 行为验证

**Files:**
- Create: `database/migrations/167_permission_consolidation.sql`
- Create: `database/scripts/verify_permission_consolidation.sql`

**Interfaces:**
- Consumes: 现有 `data_permissions`（072 schema）、`org_departments`（有权限列）、`retail_query_user_perms`（遗留表）、`get_user_perms(VARCHAR)`（旧实现）、`roles`（5 行种子）
- Produces: `get_user_perms(VARCHAR)` 新实现——返回结构不变 `{role_code, branch_nums, brands, categories, can_see_cost, default_landing, default_metric, visible_panels}`；`permission_audit` 表（供 Task 2 audit 路由读）；`data_permissions` 的 dept/user 行收编完成（供 Task 2 管理 API 读写）

- [ ] **Step 1: 写迁移文件 `167_permission_consolidation.sql`**

```sql
-- 167_permission_consolidation.sql
-- 权限体系重构（issue #2 / spec 2026-08-13-permission-refactor-design.md）：
-- data_permissions 单表授权 + get_user_perms 逐维合成 + permission_audit。
-- 幂等：migrate.sh 可重复执行；ON_ERROR_STOP=1 整体回滚。
BEGIN;

-- ① data_permissions 语义：NULL = 该维未配置（不参与合成）
ALTER TABLE data_permissions ALTER COLUMN branch_nums SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN brands    SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN categories SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN can_see_cost SET DEFAULT NULL;
COMMENT ON COLUMN data_permissions.branch_nums IS '门店范围；NULL=该维未配置；["*"]=全放行';
COMMENT ON COLUMN data_permissions.brands IS '品牌范围；NULL=该维未配置（dept 行恒 NULL）';
COMMENT ON COLUMN data_permissions.categories IS '品类范围；NULL=该维未配置（dept 行恒 NULL）';
COMMENT ON COLUMN data_permissions.can_see_cost IS '成本可见；NULL=该维未配置';

-- ② 部门权限收编：org_departments(权限列) → data_permissions(subject_type='dept')
INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
SELECT 'dept', d.id::text, d.branch_nums, NULL, NULL, d.can_see_cost, '迁移自org_departments'
FROM org_departments d
WHERE d.is_active
  AND NOT EXISTS (SELECT 1 FROM data_permissions dp
                  WHERE dp.subject_type='dept' AND dp.subject_id=d.id::text);

-- ③ 老按人表收编 + 退役
INSERT INTO data_permissions (subject_type, subject_id, branch_nums, can_see_cost, note)
SELECT 'user', wecom_id, branch_nums, can_see_cost, '迁移自retail_query_user_perms'
FROM retail_query_user_perms r
WHERE NOT EXISTS (SELECT 1 FROM data_permissions dp
                  WHERE dp.subject_type='user' AND dp.subject_id=r.wecom_id);
DROP TABLE IF EXISTS retail_query_user_perms;

-- ④ org_departments 权限列退休（唯一引用 get_user_perms + preview 路由，均本轮改写）
ALTER TABLE org_departments DROP COLUMN IF EXISTS branch_nums;
ALTER TABLE org_departments DROP COLUMN IF EXISTS can_see_cost;

-- ⑤ 变更审计表
CREATE TABLE IF NOT EXISTS permission_audit (
  id             SERIAL PRIMARY KEY,
  actor_wecom_id TEXT NOT NULL,
  actor_name     TEXT,
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT,
  payload_before JSONB,
  payload_after  JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE permission_audit IS '权限变更审计（仅经管理 API 写；SQL 直改绕不过，运维文档注明一律走页面）';

-- ⑥ get_user_perms 逐维合成重写（签名/返回结构/兜底语义均不变）
DROP FUNCTION IF EXISTS get_user_perms(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role_id INT; v_dept_ids JSONB;
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_out_branch JSONB := '[]'::jsonb; v_out_brands JSONB := '[]'::jsonb;
  v_out_cats JSONB := '[]'::jsonb;  v_out_cost BOOLEAN := false;
  v_user_branch JSONB; v_user_brands JSONB; v_user_cats JSONB; v_user_cost BOOLEAN;
  v_has_user BOOLEAN := false;
  v_ub JSONB := NULL; v_ubr JSONB := NULL; v_uc JSONB := NULL; v_ucost BOOLEAN := NULL;
BEGIN
  -- 0) 用户 + 角色 + 部门
  SELECT u.role_id, u.department_ids INTO v_role_id, v_dept_ids
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  -- 1) 角色 UI 档案
  IF v_role_id IS NOT NULL THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.id = v_role_id AND r.is_active;
  END IF;

  -- 2) 个人 override：逐维「是否配了」（非 NULL）+ 配置值
  SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
  WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
    AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  IF v_has_user THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
      INTO v_ub
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
      INTO v_ubr
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.brands IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
      INTO v_uc
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.categories IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT bool_or(dp.can_see_cost) INTO v_ucost
    FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.can_see_cost IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  END IF;

  -- 3) 基底：角色行 ∪ 部门行（四维，忽略 NULL 维，过滤过期）
  WITH rows AS (
    SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
    WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
      AND ( (dp.subject_type='role' AND dp.subject_id = v_role_id::text)
         OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
             AND (dp.subject_id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))))
       )
  ), b AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.branch_nums,'[]'::jsonb)) AS n(e)
    WHERE r.branch_nums IS NOT NULL
  ), br AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.brands,'[]'::jsonb)) AS n(e)
    WHERE r.brands IS NOT NULL
  ), c AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.categories,'[]'::jsonb)) AS n(e)
    WHERE r.categories IS NOT NULL
  ), cost AS (
    SELECT coalesce(bool_or(r.can_see_cost), false) v FROM rows r WHERE r.can_see_cost IS NOT NULL
  )
  SELECT b.v, br.v, c.v, cost.v INTO v_out_branch, v_out_brands, v_out_cats, v_out_cost FROM b, br, c, cost;

  -- 4) 合成：个人该维「配了」→ 覆盖；否则基底
  IF v_ub  IS NOT NULL THEN v_out_branch := v_ub;  END IF;
  IF v_ubr IS NOT NULL THEN v_out_brands := v_ubr; END IF;
  IF v_uc  IS NOT NULL THEN v_out_cats   := v_uc;  END IF;
  IF v_ucost IS NOT NULL THEN v_out_cost  := v_ucost; END IF;

  -- 5) 兜底：含 "*" 收敛为 ["*"]；空数组 → ["*"]
  IF v_out_branch @> '"*"'::jsonb THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF v_out_brands  @> '"*"'::jsonb THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF v_out_cats    @> '"*"'::jsonb THEN v_out_cats    := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_branch)=0 THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_brands)=0  THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_cats)=0    THEN v_out_cats    := '["*"]'::jsonb; END IF;

  RETURN jsonb_build_object('role_code', v_role_code, 'branch_nums', v_out_branch, 'brands', v_out_brands,
    'categories', v_out_cats, 'can_see_cost', v_out_cost,
    'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels);
END;
$$;
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC：角色∪部门基底叠加，个人 override 按字段覆盖（NULL=不覆盖）；返回四维+角色 UI 字段';

GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;

COMMIT;
```

- [ ] **Step 2: 写行为验证脚本 `database/scripts/verify_permission_consolidation.sql`**

构造冒烟数据（可重复执行），断言新 `get_user_perms` 的逐维规则。注意勿污染生产：脚本头部 `BEGIN; DELETE ... WHERE note LIKE 'verify%'` 先清场 → 插入 verify 数据 → `DO $$ ... RAISE EXCEPTION` 断言 → ROLLBACK：

```sql
-- verify_permission_consolidation.sql —— 逐维合成行为验证（migrate 167 后跑；幂等；末尾 ROLLBACK 不留痕）
BEGIN;
-- 清场（幂等）：删除验证期间创建但未回滚的残留
DELETE FROM data_permissions WHERE note LIKE '[verify]%';
DELETE FROM org_users WHERE wecom_id IN ('vp_zhang','vp_wang','vp_li','vp_zhao');
DELETE FROM org_departments WHERE id IN ('vp_d1','vp_d2');
DELETE FROM roles WHERE code IN ('vp_role_a','vp_role_b');

-- 环境：1 角色（全门店+水果+不可见成本）+ 2 部门（d1=门店1,2+成本false；d2=门店2,3+成本true）
INSERT INTO roles (code,name,default_landing,visible_panels) VALUES ('vp_role_a','verifyA','/','[]');
INSERT INTO org_departments (id,name,is_active) VALUES ('vp_d1','verifyD1',true),('vp_d2','verifyD2',true);
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost,note)
SELECT 'role', id::text, '["*"]','["*"]','["水果"]',false,'[verify]角色默认' FROM roles WHERE code='vp_role_a';
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,brands,categories,can_see_cost,note)
VALUES ('dept','vp_d1','["1","2"]',NULL,NULL,false,'[verify]部门1'),
       ('dept','vp_d2','["2","3"]',NULL,NULL,true,'[verify]部门2');
-- 用户（department_ids 关联部门）
INSERT INTO org_users (wecom_id,name,department_ids,is_active,role_id)
VALUES ('vp_zhang','张三',ARRAY['vp_d1','vp_d2'],true,(SELECT id FROM roles WHERE code='vp_role_a')),
       ('vp_wang','王五',ARRAY['vp_d1'],true,(SELECT id FROM roles WHERE code='vp_role_a')),
       ('vp_li','李四',ARRAY['vp_d2'],true,(SELECT id FROM roles WHERE code='vp_role_a')),
       ('vp_zhao','赵六',ARRAY['vp_d1'],true,(SELECT id FROM roles WHERE code='vp_role_a'));
-- 个人 override：王五「只填门店 ['9'] + 成本 true」→ 应覆盖门店/成本，品牌/品类继承
INSERT INTO data_permissions (subject_type,subject_id,branch_nums,can_see_cost,note)
VALUES ('user','vp_wang','["9"]',true,'[verify]个人覆盖门店+成本');

-- 断言
DO $$
DECLARE p jsonb;
BEGIN
  -- 张三：无 override → 基底并集。门店=角色*∪d1∪d2 → ["*"]收敛；品类=角色["水果"]；成本=role false OR d1 false OR d2 true=true
  p := get_user_perms('vp_zhang');
  ASSERT p->>'branch_nums' = '["*"]', '张三门店应[*]: '||p->>'branch_nums';
  ASSERT p->>'categories' = '["水果"]', '张三品类应[水果]: '||p->>'categories';
  ASSERT (p->>'can_see_cost')::boolean = true, '张三成本应 true(部门d2): '||p->>'can_see_cost';

  -- 王五：override 配了门店+成本 → 覆盖；品类继承角色
  p := get_user_perms('vp_wang');
  ASSERT p->>'branch_nums' = '["9"]', '王五门店应[9](覆盖): '||p->>'branch_nums';
  ASSERT p->>'categories' = '["水果"]', '王五品类应[水果](继承): '||p->>'categories';
  ASSERT (p->>'can_see_cost')::boolean = true, '王五成本应 true(覆盖): '||p->>'can_see_cost';

  -- 赵六：无 override、部门 d1（cost false）→ 成本 false；门店=角色[*]∪d1 并集 → ["*"] 收敛
  p := get_user_perms('vp_zhao');
  ASSERT p->>'branch_nums' = '["*"]', '赵六门店应[ * ](角色全放): '||p->>'branch_nums';
  ASSERT (p->>'can_see_cost')::boolean = false, '赵六成本应 false: '||p->>'can_see_cost';

  -- 李四（部门 d2 成本 true）再验并集 [2,3] + 成本 true
  p := get_user_perms('vp_li');
  ASSERT p->>'branch_nums' = '["2","3"]', '李四门店应[2,3](d2): '||p->>'branch_nums';
  ASSERT (p->>'can_see_cost')::boolean = true, '李四成本应 true(d2): '||p->>'can_see_cost';

  RAISE NOTICE '✔ verify_permission_consolidation: 全部断言通过';
END $$;
ROLLBACK;
```

> 断言脚本在 DO 块内用 `roles WHERE code='vp_role_a'` 子查询取角色 id，可直接运行；先在 dev 库跑（生产只在迁移后核对用，勿带注释数据执行本脚本）。

- [ ] **Step 3: 本地 dev 库跑迁移 + 验证**

```bash
cd /Users/duo/orca/workspaces/data-analysis/issue-2/deploy && docker compose up -d postgres  # dev 栈
bash ../scripts/migrate.sh   # 167 最后一次执行（含重写 get_user_perms）
docker compose exec -T postgres psql -U postgres -d insforge -f /migrations/../../scripts/verify_permission_consolidation.sql 2>&1 | tail -5
```

Expected: `✔ verify_permission_consolidation: 全部断言通过`；随后手动抽查：
```bash
docker compose exec -T postgres psql -U postgres -d insforge -c "SELECT get_user_perms('<某真实 wecom_id>');"
```
与迁移前快照对比（无 override 用户四维应一致）。

- [ ] **Step 4: 幂等重跑验证**

```bash
bash ../scripts/migrate.sh && echo "未报错=幂等通过"
docker compose restart postgrest   # 刷 schema 缓存（加列/新表/新函数后铁律）
```

- [ ] **Step 5: 提交**

```bash
git add database/migrations/167_permission_consolidation.sql database/scripts/verify_permission_consolidation.sql
git commit -m "feat(database): 权限收编迁移167——data_permissions 单表授权+get_user_perms 逐维合成+permission_audit"
```

---

## Task 2: 管理 API（改造 + 新增，全部 requireAdmin + 路由单测）

**Files:**
- Modify: `web/app/api/admin/permissions/users/route.ts`
- Modify: `web/app/api/admin/permissions/preview/route.ts`
- Create: `web/app/api/admin/permissions/users/[wecom_id]/route.ts`
- Create: `web/app/api/admin/permissions/depts/route.ts`
- Create: `web/app/api/admin/permissions/roles/route.ts`
- Create: `web/app/api/admin/permissions/roles/[id]/route.ts`
- Create: `web/app/api/admin/permissions/audit/route.ts`
- Test: `web/app/api/admin/permissions/users/__tests__/route.test.ts`、`.../depts/__tests__/route.test.ts`、`.../audit/__tests__/route.test.ts`（先例：`web/app/api/admin/reports/item-top/__tests__/route.test.ts` 用 vitest mock `vi.stubGlobal('fetch', ...)` 或 mock `@/lib/api`；权限路由直连 PostgREST 的用 **mock global fetch** + 带 cookie 的 `NextRequest`）

**Interfaces:**
- Consumes: `data_permissions`（Task 1 收编后 schema：dept/user 行、`expires_at`、四维 NULL 语义）、`permission_audit`、`requireAdmin`（`@/lib/admin-api-auth`）、`web/lib/auth.ts` `ADMIN_USERIDS`
- Produces: 前端 Task 3 消费的 JSON 契约：
  - `GET /depts → {departments: DeptRow[]}`，`DeptRow = {id,name,parent_id,is_active, branch_nums, can_see_cost, auto_role_id, auto_role_name}`
  - `PUT /depts {id, branch_nums?, can_see_cost?} → {ok:true}`（upsert dept 行；brands/categories 恒 NULL；写审计）
  - `GET /users/:wecom_id → {user, override: {id,branch_nums,brands,categories,can_see_cost,expires_at,note}|null}`
  - `PUT /users/:wecom_id {branch_nums?,brands?,categories?,can_see_cost?,expires_at?,note?}`（null=未配；全 null → 删行=恢复继承；写审计）
  - `DELETE /users/:wecom_id → {ok:true}`（删 override 行；写审计）
  - `GET /roles → {roles: RoleRow[]}`，`RoleRow = {id,code,name,default_landing,default_metric,visible_panels,is_active, branch_nums,brands,categories,can_see_cost}`
  - `PUT /roles/:id {default_landing?,default_metric?,visible_panels?,is_active?, branch_nums?,brands?,categories?,can_see_cost?} → {ok:true}`（参数 + 角色默认范围行；写审计）
  - `GET /audit?limit=50 → {items: AuditItem[]}`，`AuditItem = {id,actor_wecom_id,actor_name,action,subject_type,subject_id,payload_before,payload_after,created_at}`

- [ ] **Step 1: 写审计写入辅助 `web/lib/permission-audit.ts`**（各写路由复用，避免重复）

```ts
// web/lib/permission-audit.ts
// 权限变更审计写入（管理 API 写路径第二步；失败仅记日志不阻断主操作）
import { NextRequest } from 'next/server';

export interface AuditParams {
  action: string;                 // assign_role / upsert_data_permission / delete_data_permission / update_role
  subjectType: string;            // user / dept / role
  subjectId: string;
  before: unknown;                // 改动前 payload（可 null）
  after: unknown;                 // 改动后 payload
}

export function actorOf(req: NextRequest): { wecom_id: string; name: string | null } {
  return {
    wecom_id: req.cookies.get('wecom_userid')?.value ?? 'unknown',
    // name 由调用方从 org_users 查（可为空）
    name: null,
  };
}

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

export async function writeAudit(req: NextRequest, params: AuditParams): Promise<void> {
  try {
    const actor = actorOf(req);
    await fetch(`${POSTGREST_URL}/permission_audit`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        actor_wecom_id: actor.wecom_id, actor_name: actor.name,
        action: params.action, subject_type: params.subjectType, subject_id: params.subjectId,
        payload_before: params.before ?? null, payload_after: params.after ?? null,
      }),
    });
  } catch (e) {
    console.error('[permission-audit] write failed:', e);   // 降级：不阻断主操作
  }
}
```

- [ ] **Step 2: 改 `users/route.ts` GET**——部门列改从 `data_permissions` 聚合（保留角色/用户/部门基础字段返回，向前端 Task 3 提供）：

```ts
// GET：用户 + 角色 + 部门（部门权限从 data_permissions 聚合；department 基础信息仍查 org_departments）
const [u, r] = await Promise.all([
  fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids,role_id,role_source&is_active=eq.true&order=name`, { headers: H, cache: 'no-store' }),
  fetch(`${POSTGREST_URL}/roles?select=id,code,name&is_active=eq.true&order=sort_order`, { headers: H, cache: 'no-store' }),
]);
// 部门基础 + dept 权限行（注意 dept 行可能不存在 → 权限为缺省）
const d = await fetch(`${POSTGREST_URL}/org_departments?select=id,name,parent_id,is_active&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' });
const perms = await fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept`, { headers: H, cache: 'no-store' });
// 合并：department.branch_nums = 对应 dept 行 branch_nums ?? null；can_see_cost 同理
```

（PUT 角色指派逻辑不动。）

- [ ] **Step 3: 改 `preview/route.ts`**——部门权限改读 `data_permissions` dept 行（替代原 `org_departments.branch_nums/can_see_cost`）：

```ts
const depts = await fetch(`${POSTGREST_URL}/org_departments?select=id,name&is_active=eq.true&order=id`...);
const deptPerm = await fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept&subject_id=in.(${deptIds.map(x => `"${x}"`).join(',')})`...);
// layers.departments = depts.map(d => ({...d, branch_nums: deptPerm.find(p=>p.subject_id===d.id)?.branch_nums ?? null, can_see_cost: ...}))
```

（`effective` 仍 = `get_user_perms` RPC 结果，不用改。）

- [ ] **Step 4: 新增 `users/[wecom_id]/route.ts`**（个人 override：GET 详情 / PUT upsert / DELETE 删除恢复继承；PUT 全字段 null → 等同删除）

```ts
// GET
export async function GET(req: NextRequest, { params }: { params: { wecom_id: string } }) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent(params.wecom_id);
  const [userArr, over] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name&wecom_id=eq.${encodeURIComponent(w)}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []),
  ]);
  return NextResponse.json({ user: userArr[0] ?? null, override: over.length ? over[over.length - 1] : null });
}

// PUT：权威替换该 user 的 override（null=未配；全 null → 删行）
export async function PUT(req: NextRequest, { params }: { params: { wecom_id: string } }) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent(params.wecom_id);
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });
  const has = (b.branch_nums ?? null) !== null || (b.brands ?? null) !== null
    || (b.categories ?? null) !== null || (b.can_see_cost ?? null) !== null;

  // 读旧值（审计用）
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);

  if (!has) {
    // 全 null → 删除（恢复继承）
    if (old.length) {
      await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${old.map(x => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
      await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: old[old.length - 1], after: null });
    }
    return NextResponse.json({ ok: true });
  }
  const body = {
    subject_type: 'user', subject_id: w, note: b.note ?? null,
    branch_nums: b.branch_nums ?? null, brands: b.brands ?? null,
    categories: b.categories ?? null, can_see_cost: b.can_see_cost ?? null,
    expires_at: b.expires_at ?? null,
  };
  const r = await (old.length
    ? fetch(`${POSTGREST_URL}/data_permissions?id=eq.${old[old.length - 1].id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...body, subject_type: undefined, subject_id: undefined }) })
    : fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, { action: 'upsert_data_permission', subjectType: 'user', subjectId: w, before: old[old.length - 1] ?? null, after: body });
  return NextResponse.json({ ok: true });
}

// DELETE：删全部该 user 的 override 行
export async function DELETE(req: NextRequest, { params }: { params: { wecom_id: string } }) {
  const deny = requireAdmin(req); if (deny) return deny;
  const w = decodeURIComponent(params.wecom_id);
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.user&subject_id=eq.${encodeURIComponent(w)}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  if (old.length) {
    await fetch(`${POSTGREST_URL}/data_permissions?id=in.(${old.map(x => x.id).join(',')})`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
  }
  await writeAudit(req, { action: 'delete_data_permission', subjectType: 'user', subjectId: w, before: old[old.length - 1] ?? null, after: null });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: 新增 `depts/route.ts`**（GET 部门列表含权限 + 自动角色；PUT upsert dept 权限行，brands/categories 恒 NULL）：

```ts
// GET：部门 + dept 权限行 + 自动角色（dept_role_mapping）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const [d, p, m, r] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_departments?select=id,name,parent_id,is_active&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,can_see_cost&subject_type=eq.dept`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/dept_role_mapping?select=dept_id,role_id`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/roles?select=id,code,name`, { headers: H, cache: 'no-store' }),
  ]);
  const [depts, deptPerms, mappings, roles] = await Promise.all([d.json(), p.json(), m.json(), r.json()]);
  const roleName = new Map(roles.map((r: any) => [r.id, r.name]));
  const departments = (depts as any[]).map(dd => {
    const dp = deptPerms.find((x: any) => x.subject_id === dd.id);
    const m = mappings.find((x: any) => x.dept_id === dd.id);
    return { ...dd, branch_nums: dp?.branch_nums ?? null, can_see_cost: dp?.can_see_cost ?? null,
             auto_role_id: m?.role_id ?? null, auto_role_name: m ? roleName.get(m.role_id) ?? null : null };
  });
  return NextResponse.json({ departments });
}

// PUT { id, branch_nums?, can_see_cost? }：upsert dept 行（brands/categories 恒 NULL）
export async function PUT(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.id) return NextResponse.json({ ok: false, error: '缺 id' }, { status: 400 });
  const old = await fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost,expires_at,note&subject_type=eq.dept&subject_id=eq.${encodeURIComponent(String(b.id))}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []);
  const body = { subject_type: 'dept', subject_id: String(b.id), branch_nums: b.branch_nums ?? null, brands: null, categories: null, can_see_cost: b.can_see_cost ?? null, note: '部门tab修改' };
  const r = await (old.length
    ? fetch(`${POSTGREST_URL}/data_permissions?id=eq.${old[old.length - 1].id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ branch_nums: body.branch_nums, can_see_cost: body.can_see_cost, note: body.note }) })
    : fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) }));
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  await writeAudit(req, { action: 'upsert_data_permission', subjectType: 'dept', subjectId: String(b.id), before: old[old.length - 1] ?? null, after: body });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: 新增 `roles/route.ts` 与 `roles/[id]/route.ts`**（GET 角色列表含默认范围行；PUT 改参数 + 默认范围，写审计）：

```ts
// GET /roles：角色参数 + 角色默认范围（data_permissions subject_type='role'）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const [r, p] = await Promise.all([
    fetch(`${POSTGREST_URL}/roles?select=id,code,name,default_landing,default_metric,visible_panels,is_active&order=sort_order`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/data_permissions?select=subject_id,branch_nums,brands,categories,can_see_cost&subject_type=eq.role`, { headers: H, cache: 'no-store' }),
  ]);
  const [roles, perms] = await Promise.all([r.json(), p.json()]);
  return NextResponse.json({ roles: (roles as any[]).map(ro => {
    const dp = perms.find((x: any) => x.subject_id === String(ro.id));
    return { ...ro, branch_nums: dp?.branch_nums ?? null, brands: dp?.brands ?? null, categories: dp?.categories ?? null, can_see_cost: dp?.can_see_cost ?? null };
  }) });
}

// PUT /roles/:id：可只传部分字段；涉及参数写 roles，涉及范围写 data_permissions role 行
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const deny = requireAdmin(req); if (deny) return deny;
  const id = Number(params.id); if (!id) return NextResponse.json({ ok: false, error: 'bad id' }, { status: 400 });
  const b = await req.json().catch(() => null);
  if (!b) return NextResponse.json({ ok: false, error: '缺 body' }, { status: 400 });
  // 先读旧值（审计）
  const [oldRole, oldPerm] = await Promise.all([
    fetch(`${POSTGREST_URL}/roles?select=code,name,default_landing,default_metric,visible_panels,is_active&id=eq.${id}`, { headers: H }).then(r => r.json()).catch(() => []),
    fetch(`${POSTGREST_URL}/data_permissions?select=id,branch_nums,brands,categories,can_see_cost&subject_type=eq.role&subject_id=eq.${id}&order=id,asc`, { headers: H }).then(r => r.json()).catch(() => []),
  ]);
  // 1) roles 参数（只 patch 提供的字段）
  const rolePatch: Record<string, unknown> = {};
  if ('default_landing' in b) rolePatch.default_landing = b.default_landing;
  if ('default_metric' in b) rolePatch.default_metric = b.default_metric;
  if ('visible_panels' in b) rolePatch.visible_panels = b.visible_panels;
  if ('is_active' in b) rolePatch.is_active = b.is_active;
  if (Object.keys(rolePatch).length) {
    const rr = await fetch(`${POSTGREST_URL}/roles?id=eq.${id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rolePatch) });
    if (!rr.ok) return NextResponse.json({ ok: false, error: await rr.text() }, { status: 502 });
  }
  // 2) 默认范围：任一范围字段提供 → upsert role 行（未提供的范围维 = 旧值合并或 NULL；整行为 null → DELETE）
  if (['branch_nums','brands','categories','can_see_cost'].some(k => k in b)) {
    const merged = {
      branch_nums: b.branch_nums ?? oldPerm[0]?.branch_nums ?? null,
      brands: b.brands ?? oldPerm[0]?.brands ?? null,
      categories: b.categories ?? oldPerm[0]?.categories ?? null,
      can_see_cost: b.can_see_cost ?? oldPerm[0]?.can_see_cost ?? null,
    };
    const allNull = Object.values(merged).every(v => v === null);
    if (allNull && oldPerm.length) {
      await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPerm[0].id}`, { method: 'DELETE', headers: { ...H, Prefer: 'return=minimal' } });
    } else if (!allNull) {
      const body = { subject_type: 'role', subject_id: String(id), ...merged, note: '角色tab修改' };
      if (oldPerm.length) {
        await fetch(`${POSTGREST_URL}/data_permissions?id=eq.${oldPerm[0].id}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ ...merged, note: body.note }) });
      } else {
        await fetch(`${POSTGREST_URL}/data_permissions`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
      }
    }
  }
  await writeAudit(req, { action: 'update_role', subjectType: 'role', subjectId: String(id), before: { role: oldRole[0] ?? null, perm: oldPerm[0] ?? null }, after: b });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 7: 新增 `audit/route.ts`**：

```ts
// GET /audit?limit=50：最近变更（倒序）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 50) || 50, 200);
  const r = await fetch(`${POSTGREST_URL}/permission_audit?select=id,actor_wecom_id,actor_name,action,subject_type,subject_id,payload_before,payload_after,created_at&order=created_at.desc,id.desc&limit=${limit}`, { headers: H, cache: 'no-store' });
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  return NextResponse.json({ items: await r.json() });
}
```

- [ ] **Step 8: 写路由单测（vitest）**——关键用例：`depts PUT`（upsert had audit）、`users/:wecom_id PUT`（全 null → 删行）、`audit GET`。先例模式：mock global fetch + 带 cookie 的 `NextRequest`：

```ts
// web/app/api/admin/permissions/depts/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, PUT } from '../route';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('@/lib/permission-audit', () => ({ writeAudit: vi.fn() }));

function mkReq(method: 'GET' | 'PUT', body?: unknown) {
  return new NextRequest('http://localhost/api/admin/permissions/depts', {
    method,
    headers: { 'Content-Type': 'application/json', cookie: 'insforge_access_token=x; wecom_userid=ZhangDuo' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => fetchMock.mockReset());

describe('GET /depts', () => {
  it('合并 dept 权限行与自动角色', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [{ id: 'd1', name: '运营部', parent_id: null, is_active: true }] })
      .mockResolvedValueOnce({ json: async () => [{ subject_id: 'd1', branch_nums: ['1','2'], can_see_cost: true }] })
      .mockResolvedValueOnce({ json: async () => [{ dept_id: 'd1', role_id: 1 }] })
      .mockResolvedValueOnce({ json: async () => [{ id: 1, code: 'boss', name: '老板/运营总' }] });
    const res = await GET(mkReq('GET'));
    expect((await res.json()).departments[0]).toMatchObject({ id: 'd1', branch_nums: ['1','2'], can_see_cost: true, auto_role_name: '老板/运营总' });
  });
});

describe('PUT /depts', () => {
  it('upsert dept 权限行并写审计', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => [] })                       // 读旧（无行）
      .mockResolvedValueOnce({ ok: true })                                    // POST data_permissions
      .mockResolvedValue({ ok: true });                                       // writeAudit 已 mock
    const res = await PUT(mkReq('PUT', { id: 'd1', branch_nums: ['5','7'], can_see_cost: false }));
    expect((await res.json()).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('data_permissions'), expect.objectContaining({ method: 'POST' }));
  });
});
```

（`users/:wecom_id`、`audit` 测试同理，各 ≥2 用例；跑 `cd web && npx vitest run` 全绿。）

- [ ] **Step 9: 跑测试 + build**

```bash
cd /Users/duo/orca/workspaces/data-analysis/issue-2/web && npx vitest run
npm run build     # next build 全链路编译（含新路由）；CLAUDE.md：跨包 JSON 坑别引入根外 import
```

- [ ] **Step 10: 提交**

```bash
git add web/lib/permission-audit.ts web/app/api/admin/permissions/
git commit -m "feat(web): 权限管理 API——个人 override/depts/roles/audit 路由 + users/preview 改造 + 审计写入"
```

---

## Task 3: 前端 /admin/permissions 重组（三 tab）

**Files:**
- Modify: `web/app/admin/permissions/page.tsx`（重组）

**Interfaces:**
- Consumes: Task 2 全部 API 契约（`/depts`、`/users/:wecom_id`、`/roles`、`/audit`、既有 `/users`、`/preview`）、`/api/admin/branches`（dim_branch 门店数据）、`/api/admin/brands`
- Produces: 可操作的管理页（三 tab + 审计区）

- [ ] **Step 1: 页面骨架——三 tab + 审计区**

```tsx
// page.tsx 结构（'use client'）
const [tab, setTab] = useState<'users' | 'depts' | 'roles'>('users');
const [audit, setAudit] = useState<AuditItem[]>([]);
// 三 tab + 「最近变更」右侧面板（/audit 拉取）
// Tab 用户 = 现列表 + 「单独授权」按钮 → OverrideEditor（弹窗）
// Tab 部门 = DeptList + DeptEditor（StorePicker + 成本开关 + 自动角色只读）
// Tab 角色 = RoleList + RoleEditor（参数 + 默认范围四维）
```

- [ ] **Step 2: `StorePicker` 组件（品牌感知 + 战区/区域分组 + 搜索；勾选存 branch_nums）**

```tsx
// 数据：GET /api/admin/branches?sbc=<brand>&page=1&page_size=500（复用现门店列表接口，含 first_level_region/second_level_region）
// 表现：品牌 Tab（3120 熊喵 / 64188 品品甜，来自 /api/admin/brands）→ 战区分组（东部/南部/西部/中部）→ 二级区域 → 门店行
//      行 = [checkbox] branch_num branch_name
//      顶部：「全选（该品牌）」「清空」+ 「全部门(*) 放行」开关
// 值：branch_nums: string[]（选中即 push branch_num 字符串；切换品牌不混存——展示按 (sbc,branch_num) 定位）
// 提示条（门店键铁律）：同店号跨品牌重复，仅以「品牌+门店号」组合语义区分；存储仍为 branch_nums 数组
```

- [ ] **Step 3: 个人 override 编辑器（用户 tab 弹窗）**

```tsx
// 字段：brands（品牌多选）/ categories（品类多选，静态列表 水果/标品/耗材）/ StorePicker（门店）/ can_see_cost（三态：继承/可见/不可见）
//       expires_at（日期时间，默认空=永久）+ note
// 三态表达：勾选=覆盖；留空=继承（PUT 传 null）；「删除 override 恢复继承」= DELETE 按钮
// 保存 → PUT /users/:wecom_id；删除 → DELETE；成功后刷新列表 + 提示「用户重新登录后生效」
```

- [ ] **Step 4: 部门 tab（列表 + 编辑器）**

```tsx
// DeptList：GET /depts → 表（部门名 + 门店数/branch_nums 摘要 + 成本 + 自动角色 + 操作）
// DeptEditor 弹窗：StorePicker（预填现有 branch_nums）+ 成本开关（三态 true/false/null=未配）+ 门店键铁律提示条
// 保存 → PUT /depts {id, branch_nums, can_see_cost}；部门行「未配置」明确提示（branch_nums null）
```

- [ ] **Step 5: 角色 tab（列表 + 编辑器）**

```tsx
// RoleList：GET /roles → 表（角色名 + 落地页 + 默认指标 + 面板 + 默认范围摘要 + 操作）
// RoleEditor：参数（default_landing input / default_metric select / visible_panels 多选：targets,category_analysis,cost / is_active 开关）
//           + 默认范围四维（StorePicker + brands/categories 多选 + can_see_cost 三态）→ PUT /roles/:id
```

- [ ] **Step 6: 审计区 + 预览保留**

```tsx
// 「最近变更」：GET /audit?limit=20 → 表格（时间/操作者/主体/动作/详情摘要，created_at 按 Asia/Shanghai 显示）
// 生效预览（现有 PreviewView）保留在用户 tab
```

- [ ] **Step 7: build + 本地球运行**

```bash
cd /Users/duo/orca/workspaces/data-analysis/issue-2/web && npm run build
npm run dev   # 本地起 web（连 dev 栈），走查三 tab：改部门门店范围、配个人 override、删 override、改角色，审计区出现对应变更
```

Expected: build 通过；走查各操作落库 + 审计可见；**尝试验证 JWT 同步**：dev 下重登后可 `SELECT get_user_perms('<user>')` 核对新值。

- [ ] **Step 8: 提交**

```bash
git add web/app/admin/permissions/page.tsx
git commit -m "feat(web): 权限管理页重组——用户/部门/角色三 tab+门店选择器+个人override编辑器+审计区"
```

---

## Task 4: 文档同步（架构 §6.2 + 运维手册）

**Files:**
- Modify: `docs/architecture.md`（§6.2 权限表描述）
- Modify: `docs/ops/permission-maintenance.md`

- [ ] **Step 1: 更新 `docs/architecture.md` §6.2 权限表描述**

把「权限表」一节改为：`data_permissions` = 唯一授权表（role/dept/user 三 subject；四维 NULL=未配置；个人 override 按字段覆盖，角色∪部门基底叠加；`expires_at` 临时授权）+ `permission_audit` 变更审计 + `roles` UI 档案。RLS（`claim_match_or_star`）与 JWT claims 结构说明**保持不变**。附：`get_user_perms` 合成规则一行描述。

- [ ] **Step 2: 重写 `docs/ops/permission-maintenance.md`**

把「常见操作」从 SQL（`UPDATE org_departments SET branch_nums...`）改为**页面操作指引** + 只读核对 SQL：

```md
# 报表权限运维手册（2026-08-13 权限体系重构后）

## 模型
生效权限 = 个人 override（按字段覆盖）> 角色∪部门（基底叠加）。合成在 get_user_perms，
登录时写入 JWT，用户重新登录后生效。行过滤 report_*_gen（claim_match_or_star），列脱敏 can_see_cost CASE。
权限数据统一存 data_permissions（role/dept/user 三 subject）；变更一律走 /admin/permissions 页面（自动落 permission_audit），
SQL 直改绕不过审计，禁止。部门权限两维（branch_nums + can_see_cost），品牌/品类仅角色/个人层。

## 常见操作（全部走页面 /admin/permissions）
- 收窄某部门可见门店 → 部门 tab → 该部门 → 门店选择器勾选（去勾「全部门(*)」）
- 放开/收回部门成本 → 部门 tab → 成本开关
- 个人单独授权 / 临时授权（含到期） → 用户 tab → 单独授权
- 收回个人单独授权 → 用户 tab → 删除该 override（恢复继承）
- 调整角色默认范围/参数 → 角色 tab
- 指派 / 恢复角色 → 用户 tab（manual 不被同步覆盖）

## 排障
SELECT get_user_perms('<wecom_id>');   -- 合成结果
-- 核对迁移（167）后的权限行：
SELECT subject_type, subject_id, branch_nums, brands, categories, can_see_cost, expires_at FROM data_permissions ORDER BY subject_type, subject_id;
```

- [ ] **Step 3: 提交**

```bash
git add docs/architecture.md docs/ops/permission-maintenance.md
git commit -m "docs(permission): 架构§6.2 权限表描述更新 + 运维手册改页面操作"
```

---

## 执行编排（用户指定）

用户已指定：plan 完成后**用 orca 编排多 agent 开发**，并用**不同 agent 对产物 review**。建议流程：

1. 任务依赖图：Task 1（地基）→ Task 2（API，依赖迁移 schema）→ Task 3（前端，依赖 API 契约）；**Task 4 与 1–3 全并行**。
2. 开发编排：按依赖分两波并行——波 1：Task 1 + Task 4；波 2：Task 2 + Task 3（2 需 1 先落地，3 需 2 的契约先定——2/3 可在 1 后并行）。
3. Review 编排：不同 agent 分工——「Schema/迁移 reviewer」（Task 1）、「API 审查者」（Task 2 路由 + 鉴权 + 审计写路径）、「前端 reviewer」（Task 3 交互 + DESIGN.md 合规）、「安全 reviewer」（终检：零鉴权、越权、审计缺失、claim 语义）。对比冲突/缺陷后统一修订。

> 执行前用 org 编排工具（orca-cli / orchestration 技能）加载本 plan；每任务产物经过对应 review gate 再进入下一波。
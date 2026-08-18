# 推送系统 IAM 适配（方案 A：数据范围持久投影）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让推送链路（run_push / agent-query / preview）无会话地拿到与登录 claims 同源的 `data_scope`+`fields`，代签 JWT 升级为新形状使 RLS 放行。

**Architecture:** Casdoor 角色链资源（`范围|X` / `data-analysis:brand:*` / `category:*` / `field:*`）→ 写穿三径（登录/薄同步/对账）投影到 `org_users.scope_resources` → `get_user_perms` 在 SQL 内解析成新形状 `data_scope{...}+fields{cost}` → run_push 逐人 realtime → `generateScopedJwt` 签发含 `data_scope` 段的代签 JWT → RLS（scope_match_v2）放行。**登录 claims 构建 / RLS 执行点 / 生成器零改动。**

**Tech Stack:** PostgreSQL 迁移（幂等模板）、Next.js web（vitest）、Deno edge functions（CommonJS）、Casdoor HTTP API（web/lib/sync/casdoor-client.ts 复用）。

## Global Constraints

- 迁移全幂等（DROP IF EXISTS / IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE），新表/列 GRANT 后 restart postgrest（部署 runbook）。
- **门店键铁律**：输出/解析一律 branch_number（`sbc-branch_num` 复合派生），禁裸 branch_num。
- **时区**：一律 `Asia/Shanghai`。
- **部署顺序（关键）**：M1 加列 → M2 写穿+回填 → **回填跑完** → M3 切换 get_user_perms 读投影 → M4 JWT/消费侧。M3 之前必须保证活跃用户 scope_resources 已投影（否则空投影 → 全员 deny）。
- **空集 = deny（B1）**：无 branch 资源 → `branch_nums: []`，禁收敛 `["*"]`；全店集合相等才收敛 `['*']`。
- **消费侧同窗迁移**：get_user_perms 返回形状变更与 agent-query/wecom-oauth/push 引擎消费点迁移必须同一部署窗口。
- WIP=1：任一时刻一个 Task 主动开发。
- 生成器（services/semantic-generator/）零改动。

---

### Task 0: architecture.md 更新（CLAUDE.md 铁律：实施前完成）

**Files:**
- Modify: `docs/architecture.md`（§6.2 get_user_perms 新形状 + 投影；§7.4 run_push 代签 JWT 形状）
- Modify: `docs/superpowers/specs/2026-08-18-push-iam-adaptation-design.md`（§6 strict 闸判定源 groups→scope_resources 细化）

**Interfaces:** Consumes: 设计文档 §3-§11。Produces: 文档事实基础，后续 task 引用。

- [ ] **Step 1: 更新 architecture.md**

在 §6.2 `get_user_perms` 相关段落后增补「数据范围持久投影（方案 A）」：`org_users.scope_resources TEXT[]` = Casdoor 角色链范围资源键的持久投影（非真相源，只被登录/薄同步/对账写穿）；`get_user_perms` 读投影解析出新形状 `{ data_scope:{brands,categories,branch_nums}, fields:{cost} }`（SQL 内解析，语义对齐 resolveScopeKeys/collapseFullStore）；无会话链路（run_push/agent-query/preview）读此新形状。§7.4 run_push 节补充：代签 JWT 内嵌 data_scope/fields（与登录 claims 同形状）。

- [ ] **Step 2: 更新设计文档 §6 strict 闸**

把「get_user_perms_strict：前置 NULL 闸（无 role_codes ∧ 无 groups ∧ 无活跃临时授权 → NULL）」改为「（无 role_codes ∧ 无 scope_resources ∧ 无活跃临时授权 → NULL）」——门店范围源已从 groups 切换为 scope_resources。

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/superpowers/specs/2026-08-18-push-iam-adaptation-design.md
git commit -m "docs(perm): 数据范围持久投影 get_user_perms 新形状（方案 A 前置）
- architecture §6.2/§7.4：scope_resources 投影 + data_scope 新形状
- spec §6：strict 闸判定源 groups→scope_resources"
```

---

### Task 1: M1 迁移——org_users.scope_resources 列

**Files:**
- Create: `database/migrations/199_scope_resources_projection.sql`
- Test: psql 幂等重跑

**Interfaces:**
- Consumes: 现有 `org_users` 表。
- Produces: `org_users.scope_resources TEXT[] DEFAULT '{}'`（Task 2/3 写穿目标，Task 5 读取源）。

- [ ] **Step 1: 写迁移**

```sql
-- 199_scope_resources_projection.sql
-- 数据范围持久投影（方案 A）：Casdoor 角色链可达的范围资源键（归一化形态：
--   data-analysis:branch:X（X=范围|后原值）/ data-analysis:brand:* / category:* / field:*）。
-- 无会话链路（run_push/agent-query/preview）经 get_user_perms 解析 data_scope 的唯一输入。
-- 非真相源，只被写穿（登录/薄同步/对账）。幂等：IF NOT EXISTS。

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS scope_resources TEXT[] DEFAULT '{}';

COMMENT ON COLUMN org_users.scope_resources IS
  '数据范围资源键持久投影（方案 A）：Casdoor 角色链可达的范围相关资源键（归一化形态：data-analysis:branch:X / brand:* / category:* / field:*）；无会话链路经 get_user_perms 解析 data_scope 的唯一输入。非真相源，只被写穿（登录/薄同步/对账）。';
```

- [ ] **Step 2: 幂等验证**

Run: `docker compose exec postgres psql -U postgres -d insforge -c "ALTER TABLE org_users ADD COLUMN IF NOT EXISTS scope_resources TEXT[] DEFAULT '{}'"`（本地 dev 容器，重复两次，第二次不报错）＋ `\d org_users` 确认列存在。

- [ ] **Step 3: Commit**

```bash
git add database/migrations/199_scope_resources_projection.sql
git commit -m "feat(perm): org_users.scope_resources 投影列（M1，方案 A 前置）"
```

---

### Task 2: M2a 登录写穿——callback 落 scope_resources

**Files:**
- Modify: `functions/wecom-oidc-callback/index.js`（在 5b groups 写穿块 `// 5b. 写穿 org_users.groups` ~line 306-312 之后新增 5b'）
- Test: `node --check` + `deno check`（可用时）；pre-commit 钩子 bundle 校验

**Interfaces:**
- Consumes: `reachable`（fetchRolePermissions 产物，原始资源名）、`normalizeFriendlyPerm`（claims.js 已导出）。
- Produces: 登录时 `org_users.scope_resources` 写穿（best-effort，失败不阻断登录）。

- [ ] **Step 1: 新增写穿块**

在 5b groups 写穿之后追加：

```js
    // 5b'. 写穿 org_users.scope_resources 投影（方案 A）：归一化范围资源键。
    //      best-effort（失败记日志不阻断登录——漂移由 reconcile-scope-resources 对账收口）。
    //      空键也写（清陈旧投影）：授权资源被移除后，投影必须同步清空，否则 over-grant 残留。
    try {
      const scopeKeys = (reachable ?? [])
        .map((k) => normalizeFriendlyPerm(k))
        .filter((k) => typeof k === "string" && (
          k === "*" ||
          k.startsWith("data-analysis:branch:") ||
          k.startsWith("data-analysis:brand:") ||
          k.startsWith("data-analysis:category:") ||
          k.startsWith("data-analysis:field:")));
      await client.database.from("org_users").update({
        scope_resources: scopeKeys,
      }).eq("wecom_id", wecomUserId);
    } catch (e) { console.error("scope_resources projection mirror write failed", e); }
```

- [ ] **Step 2: 语法校验**

Run: `node --check functions/wecom-oidc-callback/index.js`（Expected: PASS）＋ `cd functions/wecom-oidc-callback && deno check index.js 2>/dev/null || echo "deno unavailable, node check sufficient"`。

- [ ] **Step 3: Commit**

```bash
git add functions/wecom-oidc-callback/index.js
git commit -m "feat(perm): 登录写穿 scope_resources 投影（M2a，方案 A）"
```

---

### Task 3: M2b web 侧角色链 + reconcile/backfill 脚本

**Files:**
- Create: `web/lib/sync/role-scope.ts`（web 侧 matchRolePermissions + normalizeFriendlyPerm，从 capability-catalog 派生展示名→key 映射）
- Create: `web/lib/sync/__tests__/role-scope.test.ts`
- Create: `scripts/reconcile-scope-resources.mjs`（backfill 一次性 + 每日对账）

**Interfaces:**
- Consumes: `casdoor-client.ts`（casdoorFetch）、`capability-catalog.ts`（displayNameFor 反向映射）、`scope-expand.ts`。
- Produces: `matchRolePermissions(perms, roleCodes): string[]`、`normalizeFriendlyPerm(k): string`（web 侧）；reconcile 脚本写 `org_users.scope_resources`。

- [ ] **Step 1: 写 web 侧 role-scope.ts**

```ts
// web/lib/sync/role-scope.ts
// 方案 A：Casdoor 角色链资源匹配 + 展示名归一（web 侧）。
// 与 functions/wecom-oidc-callback/claims.js 的 matchRolePermissions / normalizeFriendlyPerm
// 语义一致（契约测试防漂移）；展示名→key 映射从 capability-catalog 派生（单真相，不重复静态表）。
import { displayNameFor } from '../capability-catalog';

/** 角色链匹配（2026-08-18 三层模型强制）：只取 permission.roles 命中用户角色码的 resources 并集。
 *  permission.users 直挂 / groups 挂载天然匹配不上 → 排除。roles 全路径（shanhai/manager）vs
 *  用户角色码裸名（manager）→ split('/').pop() 归一。纯函数。 */
export function matchRolePermissions(perms: Array<{ roles?: string[]; resources?: string[] }>, myRoleCodes: string[]): string[] {
  const mine = new Set((myRoleCodes ?? []).map((r) => String(r)));
  const out = new Set<string>();
  for (const p of perms ?? []) {
    const pr = Array.isArray(p.roles) ? p.roles.map((r) => String(r)) : [];
    const hit = pr.some((r) => mine.has(r) || mine.has(String(r).split('/').pop() ?? ''));
    if (!hit) continue;
    for (const res of p.resources ?? []) if (typeof res === 'string') out.add(res);
  }
  return [...out];
}

/** 展示名 → 归一化资源键：范围|X → data-analysis:branch:X（纯前缀）；
 *  其它展示名（品牌|熊喵鲜生 等）→ 由 capability-catalog 的 displayNameFor 反向查 key。
 *  未命中原样返回。 */
export function normalizeFriendlyPerm(value: string, keyForDisplayName: (displayName: string) => string | undefined): string {
  if (typeof value === 'string' && value.startsWith('范围|')) {
    return 'data-analysis:branch:' + value.slice('范围|'.length);
  }
  const mapped = keyForDisplayName(value);
  return mapped ?? value;
}
```

capability-catalog 若没有现成的「展示名→key」反查函数，在 role-scope.ts 内构建：
```ts
import { CATALOG_KEYS } from '../capability-catalog';
// 反向映射：displayName → key（displayNameFor 的逆；重名 key 在 catalog 加载断言唯一）
export function buildKeyForDisplayName(): (dn: string) => string | undefined {
  const map = new Map<string, string>();
  for (const k of CATALOG_KEYS) {
    const dn = displayNameFor(k);
    if (dn && dn !== k) map.set(dn, k);
  }
  return (dn: string) => map.get(dn);
}
```
（先核实 capability-catalog 实际导出的 `displayNameFor`/`CATALOG_KEYS` 签名再对齐，见 Step 3。）

- [ ] **Step 2: 契约测试（与 claims.js 语义对齐）**

```ts
// web/lib/sync/__tests__/role-scope.test.ts
import { describe, it, expect } from 'vitest';
import { matchRolePermissions, normalizeFriendlyPerm } from '../role-scope';

describe('matchRolePermissions（与 claims.js 契约）', () => {
  it('只取 roles 命中用户角色码的 resources（直挂/挂载排除）', () => {
    const perms = [
      { roles: ['shanhai/boss'], resources: ['范围|全店', '字段|成本可见'] },
      { roles: [], resources: ['看板|经营总览'] },           // 直挂 → 排除
      { roles: ['shanhai/zone_manager'], resources: ['范围|东部二区'] },
    ];
    expect(matchRolePermissions(perms, ['boss'])).toEqual(['范围|全店', '字段|成本可见']);
    expect(matchRolePermissions(perms, ['zone_manager'])).toEqual(['范围|东部二区']);
    expect(matchRolePermissions(perms, ['manager'])).toEqual([]);
  });
});

describe('normalizeFriendlyPerm（范围| 前缀 + 展示名反查）', () => {
  const dn2key = (k: string) => (k === '品牌|熊喵鲜生' ? 'data-analysis:brand:3120' : undefined);
  it('范围|X → data-analysis:branch:X', () => {
    expect(normalizeFriendlyPerm('范围|全店', dn2key)).toBe('data-analysis:branch:全店');
    expect(normalizeFriendlyPerm('范围|东部二区', dn2key)).toBe('data-analysis:branch:东部二区');
  });
  it('展示名 → 反查 key；未命中原样', () => {
    expect(normalizeFriendlyPerm('品牌|熊喵鲜生', dn2key)).toBe('data-analysis:brand:3120');
    expect(normalizeFriendlyPerm('未知展示名', dn2key)).toBe('未知展示名');
  });
});
```

- [ ] **Step 3: 核实 capability-catalog 导出签名并对齐**

Run: `grep -n "export function displayNameFor\|export const CATALOG_KEYS\|displayNameFor\|CATALOG_KEYS" web/lib/capability-catalog.ts | head`。若签名与 Step 1 假设不符，调整 role-scope.ts 的 import/调用。

- [ ] **Step 4: 跑契约测试**

Run: `cd web && npx vitest run lib/sync/__tests__/role-scope.test.ts`
Expected: PASS（先按 Step 1 写测试 → 跑确认 fail「module not found」→ 实现 → PASS 的 TDD 循环）。

- [ ] **Step 5: 写 reconcile-scope-resources.mjs（backfill + 对账）**

```js
// scripts/reconcile-scope-resources.mjs
// 方案 A 对账/回填：Casdoor 逐人有效范围资源 vs org_users.scope_resources 投影 → diff 写回。
// 用法：node scripts/reconcile-scope-resources.mjs          # 默认 dry-run 只报告 diff
//       node scripts/reconcile-scope-resources.mjs --write  # 写回投影（backfill 用）
// 复用 web/lib/sync：casdoor-client（casdoorFetch）、role-scope（matchRolePermissions/normalizeFriendlyPerm）。
```
实现要点（TDD：先写期望输出断言）：
1. `GET /api/get-permissions?owner=shanhai`（casdoorFetch，org-wide 一次）。
2. 读 `org_users?is_active=eq.true&select=wecom_id,role_codes`。
3. 逐人 `matchRolePermissions(perms, role_codes)` → `normalizeFriendlyPerm` → 范围相关键过滤（`*` / branch: / brand: / category: / field:）。
4. `--write` 时 PATCH `org_users.scope_resources`（幂等 upsert）；非 write 只打 `DIFF` 行 + 汇总（changed / unchanged / empty-keys）。
5. 逐 key 失败显式反馈（与 reconcile-groups 同款红区语义），exit 非 0 供 cron 告警。

- [ ] **Step 6: 本地跑 backfill 干跑**

Run: `cd web && node ../scripts/reconcile-scope-resources.mjs`（连本地 dev，dry-run）
Expected: 输出逐人 diff 汇总（active 用户数、changed/unchanged），无报错。

- [ ] **Step 7: Commit**

```bash
git add web/lib/sync/role-scope.ts web/lib/sync/__tests__/role-scope.test.ts scripts/reconcile-scope-resources.mjs
git commit -m "feat(perm): web 侧角色链匹配 + reconcile-scope-resources 回填/对账（M2b）"
```

---

### Task 4: 执行 backfill（M3 前置，回填活跃用户 scope_resources）

**Files:**
- Test: psql 抽样验证

**Interfaces:**
- Consumes: Task 3 的 reconcile 脚本。
- Produces: 生产 `org_users.scope_resources` 全量投影（M3 切换前提）。

- [ ] **Step 1: 生产跑 backfill（写）**

Run: 服务器 `/opt/data-analytics-platform` 下（容器内 node 或宿主机 node 带 env）
`node scripts/reconcile-scope-resources.mjs --write`
Expected: changed 汇总；退出码 0。

- [ ] **Step 2: 抽样验证投影**

Run: `psql -c "select wecom_id, role_codes, scope_resources from org_users where is_active limit 10"`
Expected: boss 用户 `scope_resources` 含 `data-analysis:branch:全店`；manager 用户 = 空数组或对应配置键（取决于 Casdoor 配置，见用户数据配置）。

- [ ] **Step 3: 记录回填结果到 commit message 对应 task**

（部署回填本身不 commit；如需在后续 CI 前做投影新鲜度门禁，记录在此。）

---

### Task 5: M3 迁移——get_user_perms / strict 新形状（SQL 解析）

**Files:**
- Create: `database/migrations/200_get_user_perms_scope_resources.sql`
- Test: psql 单元（各解析分支）

**Interfaces:**
- Consumes: `org_users.scope_resources`（Task 1/4）、`maps_branch_group`、`dim_branch`。
- Produces: `get_user_perms` 返回新形状 `{ role_code, default_landing, default_metric, visible_panels, departments, data_scope:{brands,categories,branch_nums}, fields:{cost} }`；`get_user_perms_strict` NULL 闸判定源改 scope_resources。

- [ ] **Step 1: 写迁移（get_user_perms 新形状）**

```sql
-- 200_get_user_perms_scope_resources.sql
-- M3：get_user_perms 切换为「scope_resources 投影 → SQL 解析 → 新形状 data_scope+fields」。
-- 幂等：CREATE OR REPLACE。门店范围源从 org_users.groups 组推导切换为 scope_resources 资源键解析。
-- 语义对齐 claims.js resolveScopeKeys + collapseFullStore（2026-08-18 范围资源唯一真相）。

CREATE OR REPLACE FUNCTION public.get_user_perms(p_wecom_id character varying)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dept_ids JSONB;
  v_role_codes TEXT[];
  v_scope_resources TEXT[];
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_branch JSONB := '[]'::jsonb;
  v_brands JSONB := '[]'::jsonb;
  v_categories JSONB := '[]'::jsonb;
  v_cost BOOLEAN := false;
  v_branch_keys TEXT[];
  v_key TEXT; v_tmp TEXT[]; v_collapsed TEXT[]; v_name_count INT; v_name_branch TEXT;
  v_unknown BOOLEAN := false; v_ambiguous BOOLEAN := false;
  v_universe_size INT; v_result_size INT;
BEGIN
  SELECT u.department_ids, coalesce(u.role_codes, '{}'), coalesce(u.scope_resources, '{}')
    INTO v_dept_ids, v_role_codes, v_scope_resources
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    IF p_wecom_id LIKE 'system:%' THEN
      RETURN jsonb_build_object('role_code', null, 'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb,
        'departments', '[]'::jsonb, 'data_scope', jsonb_build_object('brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'branch_nums', '["*"]'::jsonb),
        'fields', jsonb_build_object('cost', false));
    END IF;
    RETURN jsonb_build_object('role_code', null, 'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb,
      'departments', '[]'::jsonb, 'data_scope', jsonb_build_object('brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'branch_nums', '[]'::jsonb),
      'fields', jsonb_build_object('cost', false));
  END IF;

  -- 角色 UI 档案（保留 175 语义）
  IF array_length(v_role_codes, 1) > 0 THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.code = ANY(v_role_codes) AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code LIMIT 1;
  END IF;

  -- 通配 '*' → 全放（管理员）
  IF v_scope_resources @> ARRAY['*']::text[] THEN
    RETURN jsonb_build_object('role_code', v_role_code, 'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels,
      'departments', v_dept_ids, 'data_scope', jsonb_build_object('brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'branch_nums', '["*"]'::jsonb),
      'fields', jsonb_build_object('cost', true));
  END IF;

  -- brands / categories / cost
  SELECT COALESCE(jsonb_agg(substring(r FROM 'data-analysis:brand:(.*)$')), '[]'::jsonb) INTO v_brands
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:brand:%';
  SELECT COALESCE(jsonb_agg(substring(r FROM 'data-analysis:category:(.*)$')), '[]'::jsonb) INTO v_categories
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:category:%';
  v_cost := EXISTS (SELECT 1 FROM unnest(v_scope_resources) r WHERE r = 'data-analysis:field:cost');

  -- branch keys 解析（fail-close：任一未知/歧义 → 整单 []）
  SELECT array_agg(substring(r FROM 'data-analysis:branch:(.*)$')) INTO v_branch_keys
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:branch:%';
  IF v_branch_keys IS NOT NULL AND array_length(v_branch_keys, 1) > 0 THEN
    IF EXISTS (SELECT 1 FROM unnest(v_branch_keys) k WHERE k IN ('*', '全店')) THEN
      v_branch := '["*"]'::jsonb;
    ELSE
      FOR v_key IN SELECT unnest(v_branch_keys) LOOP
        IF EXISTS (SELECT 1 FROM maps_branch_group WHERE is_active AND group_id = v_key) THEN
          SELECT array_agg(DISTINCT branch_number) INTO v_tmp FROM maps_branch_group
            WHERE is_active AND group_id = v_key AND branch_number IS NOT NULL;
          v_collapsed := v_collapsed || v_tmp;
        ELSIF EXISTS (SELECT 1 FROM maps_branch_group WHERE is_active AND branch_number = v_key) THEN
          v_collapsed := v_collapsed || ARRAY[v_key];
        ELSE
          SELECT count(*), min(branch_number) INTO v_name_count, v_name_branch FROM dim_branch WHERE branch_name = v_key;
          IF v_name_count = 1 THEN v_collapsed := v_collapsed || ARRAY[v_name_branch];
          ELSIF v_name_count > 1 THEN v_ambiguous := true;
          ELSE v_unknown := true;
          END IF;
        END IF;
      END LOOP;
      IF v_unknown OR v_ambiguous THEN
        v_branch := '[]'::jsonb;   -- fail-close 整单清空（B1）
      ELSE
        SELECT count(DISTINCT branch_number) INTO v_universe_size FROM maps_branch_group WHERE is_active AND branch_number IS NOT NULL;
        SELECT count(DISTINCT b) INTO v_result_size FROM unnest(v_collapsed) b;
        IF v_universe_size > 0 AND v_result_size = v_universe_size THEN
          v_branch := '["*"]'::jsonb;   -- collapseFullStore：覆盖全集 → 收敛
        ELSE
          SELECT COALESCE(jsonb_agg(b ORDER BY b), '[]'::jsonb) INTO v_branch
            FROM (SELECT DISTINCT b FROM unnest(v_collapsed) b) s;
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('role_code', v_role_code, 'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels,
    'departments', v_dept_ids,
    'data_scope', jsonb_build_object('brands', v_brands, 'categories', v_categories, 'branch_nums', v_branch),
    'fields', jsonb_build_object('cost', v_cost));
END;
$function$;
```

- [ ] **Step 2: 写 strict 闸更新（判定源 groups→scope_resources）**

```sql
-- 同迁移内：strict NULL 闸 = 无 role_codes ∧ 无 scope_resources ∧ 无活跃临时授权
CREATE OR REPLACE FUNCTION public.get_user_perms_strict(p_wecom_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_active BOOLEAN; v_empty BOOLEAN; v_perms JSONB;
BEGIN
  SELECT u.is_active INTO v_active FROM org_users u WHERE u.wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN RETURN NULL; END IF;
  SELECT coalesce(array_length(o.role_codes, 1), 0) = 0
         AND coalesce(array_length(o.scope_resources, 1), 0) = 0
         AND NOT EXISTS (SELECT 1 FROM temporary_grants tg
                         WHERE tg.user_id = p_wecom_id AND tg.revoked_at IS NULL AND tg.expires_at > now())
    INTO v_empty FROM org_users o WHERE o.wecom_id = p_wecom_id;
  IF coalesce(v_empty, true) THEN RETURN NULL; END IF;
  SELECT get_user_perms(p_wecom_id) INTO v_perms;
  RETURN v_perms;
END;
$function$;
```

- [ ] **Step 3: 单元测试各解析分支（psql）**

构造测试用户 + scope_resources，逐分支断言：
```sql
-- 分支1：全店收敛
UPDATE org_users SET scope_resources = ARRAY['data-analysis:branch:全店','data-analysis:brand:3120','data-analysis:field:cost'] WHERE wecom_id='zz_test_full';
SELECT jsonb_pretty(get_user_perms('zz_test_full'));
-- 期望：data_scope.branch_nums = ["*"], brands=["3120"], fields.cost=true

-- 分支2：分区包（东部二区 → 15 店）
UPDATE org_users SET scope_resources = ARRAY['data-analysis:branch:东部二区'] WHERE wecom_id='zz_test_zone';
SELECT jsonb_array_length(get_user_perms('zz_test_zone')->'data_scope'->'branch_nums');
-- 期望：15

-- 分支3：未知键 fail-close → []
UPDATE org_users SET scope_resources = ARRAY['data-analysis:branch:不存在的包'] WHERE wecom_id='zz_test_unknown';
SELECT get_user_perms('zz_test_unknown')->'data_scope'->'branch_nums';
-- 期望：[]

-- 分支4：空资源 → 空集 deny
UPDATE org_users SET scope_resources = ARRAY[]::text[] WHERE wecom_id='zz_test_none';
SELECT get_user_perms('zz_test_none')->'data_scope'->'branch_nums';
-- 期望：[]

-- strict：无 role_codes ∧ 无 scope_resources → NULL
UPDATE org_users SET role_codes='{}', scope_resources=ARRAY[]::text[] WHERE wecom_id='zz_test_none';
SELECT get_user_perms_strict('zz_test_none');
-- 期望：NULL
```
（测试用户用完 DELETE org_users WHERE wecom_id LIKE 'zz_test%' 清理。）

- [ ] **Step 4: 幂等重跑验证**

Run: 同一 psql 脚本跑两遍，第二遍无报错（CREATE OR REPLACE 幂等）。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/200_get_user_perms_scope_resources.sql
git commit -m "feat(perm): get_user_perms 新形状 data_scope+fields（M3，SQL 解析 scope_resources）
- get_user_perms：门店源切换 scope_resources，brands/categories/cost 从资源键解析
- get_user_perms_strict：NULL 闸判定源 groups→scope_resources"
```

---

### Task 6: M4 代签 JWT + push 引擎消费新形状

**Files:**
- Modify: `web/lib/push/render.ts`（generateScopedJwt payload）
- Modify: `web/lib/push/index.ts:368-397`（getPermsStrict 解析新形状）
- Modify: `web/lib/push/push-variables.ts:42-70`（matchesScope + Perms 类型）
- Modify: `web/lib/push/engine.ts`（Perms 类型）
- Modify: `web/lib/push/scope-signature.ts`（Perms 类型对齐）
- Test: `web/lib/push/__tests__/run-push.test.ts`、`web/lib/push/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `get_user_perms_strict` 新形状（Task 5）。
- Produces: 新形状代签 JWT（`data_scope` + `fields` 段）；Perms 类型统一为 `{ data_scope, fields }`。

- [ ] **Step 1: 更新 Perms 类型 + matchesScope**

```ts
// push-variables.ts：Perms 改为 data_scope 形状
export interface Perms {
  data_scope: { brands: string[]; categories: string[]; branch_nums: string[] };
  fields: { cost: boolean };
}

export function matchesScope(
  v: PushVariable,
  perms: Perms
): boolean {
  if (v.scope_dim === 'total') return true;
  if (v.scope_dim === 'brand') {
    if (!perms.data_scope.brands?.length) return false;
    if (perms.data_scope.brands.includes('*')) return true;
    const filterBrands = v.extra_filter?.system_book_code as string[] | undefined;
    if (!filterBrands?.length) return true;
    return filterBrands.some((b) => perms.data_scope.brands!.includes(b));
  }
  if (v.scope_dim === 'branch') {
    if (!perms.data_scope.branch_nums?.length) return false;
    if (perms.data_scope.branch_nums.includes('*')) return true;
    const filterBranches = v.extra_filter?.branch_num as string[] | undefined;
    if (!filterBranches?.length) return true;
    return filterBranches.some((b) => perms.data_scope.branch_nums!.includes(b));
  }
  return true; // war_zone/region 暂不细化
}
```
（`isCostSensitive` 不变；render 里成本脱敏判断 `perms.can_see_cost` → `perms.fields.cost`。）

- [ ] **Step 2: 更新 generateScopedJwt（render.ts）**

```ts
// payload 新形状（与登录 claims 同形状；旧顶层四维 key 摘除）
const payload = {
  role: 'authenticated',
  data_scope: perms.data_scope,
  fields: perms.fields,
  departments: perms.departments ?? [],
  iat: now,
  exp: now + 600, // 10 分钟
};
```
（`Perms` 增补可选 `departments?: string[]`。）

- [ ] **Step 3: 更新 getPermsStrict（index.ts）**

```ts
const row = data as Record<string, unknown>;
const ds = (row.data_scope ?? {}) as Record<string, unknown>;
const f = (row.fields ?? {}) as Record<string, unknown>;
return {
  data_scope: {
    brands: Array.isArray(ds.brands) ? (ds.brands as string[]) : [],
    categories: Array.isArray(ds.categories) ? (ds.categories as string[]) : [],
    branch_nums: Array.isArray(ds.branch_nums) ? (ds.branch_nums as string[]) : [],
  },
  fields: { cost: f.cost === true },
  departments: Array.isArray(row.departments) ? (row.departments as string[]) : [],
};
```

- [ ] **Step 4: 更新 render 成本脱敏 + URL 变量取值**

render.ts `renderVariables` 内 `isCostSensitive(v) && !perms.can_see_cost` → `!perms.fields.cost`；URL 变量 `params.set('branch', perms.branch_nums.join(','))` → `perms.data_scope.branch_nums.join(',')`（brands/categories 同理）。engine.ts `Perms extends Scope` 改为引用 push-variables 的 Perms。

- [ ] **Step 5: 更新测试**

`web/lib/push/__tests__/run-push.test.ts` / `engine.test.ts`：构造 `Perms` 用新形状 `{ data_scope:{brands:[],categories:[],branch_nums:[...]}, fields:{cost:false} }`；断言 JWT payload 含 data_scope、不含旧顶层 key。

- [ ] **Step 6: 跑 vitest**

Run: `cd web && npx vitest run lib/push/`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add web/lib/push/
git commit -m "feat(push): 代签 JWT 新形状 data_scope+fields + 引擎消费迁移（M4）"
```

---

### Task 7: M4b agent-query / wecom-oauth 消费新形状

**Files:**
- Modify: `functions/agent-query/index.js:340-345`（branch_nums → data_scope.branch_nums）
- Modify: `functions/wecom-oauth/index.js:83-98`（若读四维/成本则对齐）
- Test: `node --check`；pre-commit bundle 校验

**Interfaces:**
- Consumes: `get_user_perms` 新形状（Task 5）。
- Produces: 无会话链路消费端全部对齐新形状。

- [ ] **Step 1: agent-query 对齐**

`functions/agent-query/index.js` 中 `!Array.isArray(perms.branch_nums)` → 改判新形状：
```js
const ds = perms?.data_scope;
if (!perms || perms.error || !ds || !Array.isArray(ds.branch_nums)) {
  return json({ error: "no_permission", detail: perms && perms.error }, 403);
}
// runPg/runDuckdb 透传 perms 前，把 perms 归一成既有 runner 期望形状：
//   { branch_nums: ds.branch_nums, can_see_cost: perms.fields?.cost === true, ... }
```
（先读 `runPg`/`runDuckdb` 对 perms 的实际字段消费再归一，见 Step 3。）

- [ ] **Step 2: wecom-oauth 对齐**

读 `functions/wecom-oauth/index.js` 对 perms 的消费字段：若只用 role_code/UI 字段（新形状保留）→ 零改动；若读 branch_nums/can_see_cost → 同样归一。按 Step 3 核实结果决定。

- [ ] **Step 3: 核实两个 function 的 perms 字段消费**

Run: `grep -n "perms\." functions/agent-query/index.js functions/wecom-oauth/index.js`。把实际消费字段列到 task 记录，逐一映射到新形状。

- [ ] **Step 4: 语法校验 + 提交**

Run: `node --check functions/agent-query/index.js && node --check functions/wecom-oauth/index.js`
```bash
git add functions/agent-query/index.js functions/wecom-oauth/index.js
git commit -m "fix(perm): agent-query/wecom-oauth 消费 get_user_perms 新形状（M4b）"
```

---

### Task 8: M5 一致性契约 + 端到端验证

**Files:**
- Create: `web/lib/push/__tests__/scope-consistency.test.ts`
- Test: vitest + 生产端到端

**Interfaces:**
- Consumes: 全部前序 task 产物。
- Produces: 「登录 claims data_scope ↔ get_user_perms data_scope 同输入同输出」契约（防 JS/SQL 解析漂移）。

- [ ] **Step 1: 写一致性契约测试**

以 claims.js resolveScopeKeys 语义为参照，断言「同一 scope_resources 输入 → scope-expand.ts（web JS）与 get_user_perms（SQL）输出一致」：
```ts
// 用真实 maps/dim_branch fixtures（与 scope-expand.test.ts 共用），对同一组 branch keys：
//   JS 侧：expandScopeResources(keys) 结果
//   SQL 侧：构造测试用户 scope_resources 后 get_user_perms 的 data_scope.branch_nums
//   断言两者集合相等（覆盖：全店收敛 / 分区包 / branch_number / 中文名 / 未知键 fail-close）
```

- [ ] **Step 2: 生产端到端验证**

部署后（GHA 完整部署 + restart postgrest）：
1. `psql` 抽一个 boss 用户，`get_user_perms` → `data_scope.branch_nums` 含 `["*"]`、brands 非空。
2. 推送 shadow：`run_push(deliver=false)`（selector=person 测试用户）→ 确认 render 产物 detail_url 带 `jwt`（新形状），scope 签名正确。
3. 用代签 JWT 直查一个报表视图（PostgREST）→ 返回正确门店集（RLS 放行）。
4. 登录一个测试用户 → 解码 JWT，比对 `data_scope` 与 `get_user_perms` 输出一致。

- [ ] **Step 3: 记录验证结果并收尾**

把端到端结果（含各用户门店数抽样）写进 task 记录；确认无 0 门店异常之外的新增 skip。

---

## Self-Review 记录

- **Spec 覆盖**：设计 §4 投影 schema→Task1；§5 写穿三径→Task2（登录）/Task3+4（薄同步+对账）；§6 get_user_perms 新形状→Task5；§7 代签 JWT→Task6；§8 消费侧迁移→Task6/7；§9 对账与契约→Task3（reconcile）/Task8（一致性）；§11 里程碑→Task 序号一一对应。
- **占位符扫描**：无 TBD/TODO；各 task 含实际 SQL/代码/测试命令。
- **类型一致性**：Perms 新形状 `{data_scope, fields, departments?}` 在 Task6 统一，scope-signature/engine/matchesScope 全部对齐；get_user_perms 新形状 key 在 Task5 定义、Task6/7 消费同名。
- **部署顺序风险**：Task4（backfill）必须在 Task5（M3 切换）部署前执行，已列入 Global Constraints。

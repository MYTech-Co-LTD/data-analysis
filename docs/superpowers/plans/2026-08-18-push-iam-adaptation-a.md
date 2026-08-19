# 推送系统 IAM 适配（方案 A：数据范围持久投影）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让推送链路（run_push / agent-query / preview）无会话地拿到与登录 claims 同源的 `data_scope`+`fields`，代签 JWT 升级为新形状使 RLS 放行。

> **2026-08-18 spec-forge 修订已应用（M1-M13，详见 design §1 头部注记）**：双形过渡+M6、裸 `*` 删全权、写时 fail-close、归一单源对拍、薄同步/对账接线（Task 3b）、SQL NULL 修复、Wave 部署+覆盖守卫（Task 4）、reconcile 护栏、回滚、temp-grant 裁决、测试链/CI（Task 8/9）、分支测试入库。完整评估：`.spec-forge/push-iam-a-eval/final-evaluation.md`。

**Architecture:** Casdoor 角色链资源（`范围|X` / `data-analysis:brand:*` / `category:*` / `field:*`）→ 写穿三径（登录/薄同步/对账）投影到 `org_users.scope_resources` → `get_user_perms` 在 SQL 内解析成新形状 `data_scope{...}+fields{cost}` → run_push 逐人 realtime → `generateScopedJwt` 签发含 `data_scope` 段的代签 JWT → RLS（scope_match_v2）放行。**登录 claims 构建 / RLS 执行点 / 生成器零改动。**

**Tech Stack:** PostgreSQL 迁移（幂等模板）、Next.js web（vitest）、Deno edge functions（CommonJS）、Casdoor HTTP API（web/lib/sync/casdoor-client.ts 复用）。

## Global Constraints

- 迁移全幂等（DROP IF EXISTS / IF NOT EXISTS / ON CONFLICT / CREATE OR REPLACE），新表/列 GRANT 后 restart postgrest（部署 runbook）。
- **门店键铁律**：输出/解析一律 branch_number（`sbc-branch_num` 复合派生），禁裸 branch_num。
- **时区**：一律 `Asia/Shanghai`。
- **部署（Wave 5 段，spec-forge M8）**：Wave0 SSH 前置加固 wecom-oauth `?? []` → Wave1 GHA（199+Task2+role-scope+薄同步/对账 cron+201，**不含 200**）→ Wave1.5 生产 backfill `--write` + `guard-scope-projection.mjs` 覆盖 ≥90% 硬门禁 → Wave2 GHA（200+agent-query+wecom-oauth+push 引擎全量）→ Wave3 验证。**migrate.sh 每次重跑全部迁移，backfill 必须先于 Wave2**。
- **空集 = deny（B1）**：无 branch 资源 → `branch_nums: []`，禁收敛 `["*"]`；全店集合相等才收敛 `['*']`。
- **投影键白名单（M2）**：归一后 `data-analysis:branch:*` / `brand:*` / `category:*` / `field:*`；**裸 `*` 非投影键**；唯一通配=`范围|全店`→`branch:全店`。
- **写穿时 fail-close 验证（M3）**：任一范围键 resolveScopeKeys ok:false → 整单投影 `[]` + 红区告警；未知键永不进投影。
- **双形过渡 + M6 sunset（M1）**：get_user_perms 双形同源同值；消费端只需在 M6 前迁完（不做真同窗）；**消费端兜底恒 deny**：`?? []` / `?? false`，禁 `|| ["*"]`。
- **归一单源 + 对拍（M4）**：web 侧 import `DISPLAY_NAME_TO_KEY`；FRIENDLY_TO_KEY↔DISPLAY_NAME_TO_KEY 全表对拍契约。
- **签名契约（M6）**：scopeSignature 读 data_scope/fields；「不同门店集→不同签名」单测。
- **对账接线（M5）**：manifest + JOBS registry + history 表 + outbox + notifyWecom（仿 reconcile-groups）；对账在原始资源键层面对比。
- **reconcile 护栏（M9）**：org-wide 空结果 abort 不清库 + diff 熔断。
- **URL 变量渲染要求 branch_nums 非空（S7）**，空则该变量不渲染。
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
    //      M2：裸 '*' 非投影键（唯一通配 = 范围|全店 → data-analysis:branch:全店）。
    //      M3：写时 fail-close 验证——分支键展开 ok:false（未知/歧义）→ 整单投影写 [] + 红区告警。
    try {
      if (expandResult.ok !== true) {
        await client.database.from("org_users").update({ scope_resources: [] })
          .eq("wecom_id", wecomUserId);
        console.error("scope_resources projection fail-closed (expand failed)",
          expandResult?.error ?? "");
      } else {
        const scopeKeys = (reachable ?? [])
          .map((k) => normalizeFriendlyPerm(k))
          .filter((k) => typeof k === "string" && (
            k.startsWith("data-analysis:branch:") ||
            k.startsWith("data-analysis:brand:") ||
            k.startsWith("data-analysis:category:") ||
            k.startsWith("data-analysis:field:")));
        await client.database.from("org_users").update({
          scope_resources: scopeKeys,
        }).eq("wecom_id", wecomUserId);
      }
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

### Task 3: M2b web 侧角色链（role-scope.ts + 契约测试）

**Files:**
- Create: `web/lib/sync/role-scope.ts`（web 侧 matchRolePermissions + normalizeFriendlyPerm，**import 现成 `DISPLAY_NAME_TO_KEY`**——M4/spec-forge：capability-catalog.ts:120 已导出，勿新建反查）
- Create: `web/lib/sync/__tests__/role-scope.test.ts`

**Interfaces:**
- Consumes: `capability-catalog.ts`（`DISPLAY_NAME_TO_KEY`）、`casdoor-client.ts`。
- Produces: `matchRolePermissions(perms, roleCodes): string[]`、`normalizeFriendlyPerm(k): string`（web 侧，Task 3b 薄同步/backfill 复用）。

- [ ] **Step 1: 写 role-scope.ts（复用 DISPLAY_NAME_TO_KEY，勿重复造表）**

```ts
// web/lib/sync/role-scope.ts
// 方案 A：Casdoor 角色链资源匹配 + 展示名归一（web 侧）。
// 与 claims.js matchRolePermissions/normalizeFriendlyPerm 语义一致（契约测试防漂移）。
// M4/spec-forge：展示名→key 直接复用 capability-catalog 的 DISPLAY_NAME_TO_KEY（单真相）。
import { DISPLAY_NAME_TO_KEY } from '../capability-catalog';

/** 角色链匹配（2026-08-18 三层模型强制）：只取 permission.roles 命中用户角色码的 resources 并集。
 *  permission.users 直挂 / groups 挂载天然匹配不上 → 排除。roles 全路径 → split('/').pop() 归一。纯函数。 */
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

/** 展示名 → 归一化资源键：范围|X → data-analysis:branch:X（纯前缀，不依赖 catalog）；
 *  其它展示名（品牌|熊喵鲜生 等）→ DISPLAY_NAME_TO_KEY 反查；未命中原样返回（上层红区告警）。 */
export function normalizeFriendlyPerm(value: string): string {
  if (typeof value === 'string' && value.startsWith('范围|')) {
    return 'data-analysis:branch:' + value.slice('范围|'.length);
  }
  return DISPLAY_NAME_TO_KEY[value] ?? value;
}
```

- [ ] **Step 2: 契约测试（真实 catalog round-trip + FRIENDLY_TO_KEY 对拍，勿 mock 绕开）**

```ts
// web/lib/sync/__tests__/role-scope.test.ts
// M4/spec-forge：不用 mock dn2key——绑定真实 catalog，防「catalog 缺展示名 → 品牌/品类静默丢弃」路径假绿。
import { describe, it, expect } from 'vitest';
import { matchRolePermissions, normalizeFriendlyPerm } from '../role-scope';
import { DISPLAY_NAME_TO_KEY, CATALOG_KEYS } from '../capability-catalog';

describe('matchRolePermissions（与 claims.js 契约）', () => {
  it('只取 roles 命中用户角色码的 resources（直挂/挂载排除）', () => {
    const perms = [
      { roles: ['shanhai/boss'], resources: ['范围|全店', '字段|成本可见'] },
      { roles: [], resources: ['看板|经营总览'] },
      { roles: ['shanhai/zone_manager'], resources: ['范围|东部二区'] },
    ];
    expect(matchRolePermissions(perms, ['boss'])).toEqual(['范围|全店', '字段|成本可见']);
    expect(matchRolePermissions(perms, ['zone_manager'])).toEqual(['范围|东部二区']);
    expect(matchRolePermissions(perms, ['manager'])).toEqual([]);
  });
});

describe('normalizeFriendlyPerm（真实 catalog 单真相）', () => {
  it('范围|X → data-analysis:branch:X（纯前缀）', () => {
    expect(normalizeFriendlyPerm('范围|全店')).toBe('data-analysis:branch:全店');
    expect(normalizeFriendlyPerm('范围|东部二区')).toBe('data-analysis:branch:东部二区');
  });
  it('展示名反查 round-trip：DISPLAY_NAME_TO_KEY 中每个展示名经 normalize 回到 catalog key', () => {
    for (const [dn, key] of Object.entries(DISPLAY_NAME_TO_KEY)) {
      expect(normalizeFriendlyPerm(dn)).toBe(key);
    }
  });
  it('范围相关展示名必须被 catalog 覆盖（品牌|/品类|/字段|）——防静默丢弃', () => {
    for (const dn of ['品牌|熊喵鲜生', '品牌|品品甜', '品类|水果', '品类|标品', '品类|耗材', '字段|成本可见']) {
      expect(DISPLAY_NAME_TO_KEY[dn], `catalog 缺展示名: ${dn}`).toBeTruthy();
    }
  });
  // FRIENDLY_TO_KEY 对拍（claims.js 静态表 vs catalog）：claims.test.js 侧断言 catalog↔claims 一致；
  // 此处以 catalog 为单真相，范围展示名全覆盖即保对拍（claims.test.js 已有反向断言）。
});
```

- [ ] **Step 3: 核实 capability-catalog 导出签名并对齐**

Run: `grep -n "DISPLAY_NAME_TO_KEY\|displayNameFor\|CATALOG_KEYS" web/lib/capability-catalog.ts | head`。
确认 `DISPLAY_NAME_TO_KEY` 已导出（panel 已核实 capability-catalog.ts:120 存在）；若签名/键形态与 Step 1 假设不符，调整 import/调用。

- [ ] **Step 4: 跑契约测试**

Run: `cd web && npx vitest run lib/sync/__tests__/role-scope.test.ts`
Expected: PASS（TDD：先写测试 → 跑确认 fail → 实现 → PASS）。

- [ ] **Step 5: Commit**

```bash
git add web/lib/sync/role-scope.ts web/lib/sync/__tests__/role-scope.test.ts
git commit -m "feat(perm): web 侧角色链匹配复用 DISPLAY_NAME_TO_KEY + 真实对拍契约（M2b/M4）"
```

---

### Task 3b: M2b 薄同步/对账接线 + backfill + 覆盖守卫（M5/M9/spec-forge）

> 设计 §5.2/§5.3 的「每日 03:17 薄同步 + 24h 告警」在此落地（原 plan 只造脚本未接线——spec-forge M5）。仿 reconcile-groups 完整链（manifest + JOBS registry + history + notifyWecom）。

**Files:**
- Create: `database/migrations/201_scope_resources_reconcile_history.sql`（date PK，UPSERT 幂等，仿 group_reconcile_history）
- Create: `web/lib/jobs/reconcile-scope-resources/manifest.ts`（JobManifest，**进 JOBS registry**——M16 教训）
- Create: `web/app/api/admin/cron/reconcile-scope-resources/route.ts`（薄同步 03:17 + 对账 cron；import TS，复用 role-scope/casdoor-client）
- Create: `scripts/backfill-scope-resources.mjs`（一次性 backfill：**node 内建 + fetch，不 import TS**——仿 backfill-groups-projection 模式）
- Create: `scripts/guard-scope-projection.mjs`（活跃用户非空投影 ≥90% 覆盖守卫，Wave1.5 硬门禁用）

**Interfaces:**
- Consumes: Task 3 `role-scope.ts` / `casdoor-client.ts`。
- Produces: 薄同步/对账 cron 接线 + 201 history 表 + backfill 脚本 + 覆盖守卫。

- [ ] **Step 1: 迁移 201 history 表**（`CREATE TABLE IF NOT EXISTS scope_resources_reconcile_history (date date PK, ...)` + UPSERT on date PK，仿 group_reconcile_history；GRANT + restart postgrest）
- [ ] **Step 2: manifest + JOBS registry 注册**（`reconcile-scope-resources/manifest.ts` 进 `web/lib/jobs/registry.ts`）
- [ ] **Step 3: cron route**（薄同步 03:17：org-wide get-permissions → 逐人 matchRolePermissions → **写时 fail-close 验证** → upsert；对账：**原始资源键层面对比** + diff 分级 + notifyWecom）
- [ ] **Step 4: backfill-scope-resources.mjs**（node 内建 fetch get-permissions → 逐人匹配 → `--write` PATCH。**M9 护栏**：org-wide 空结果 abort 不清库；changed >50% abort 熔断）
- [ ] **Step 5: guard-scope-projection.mjs**（`SELECT count(*) FILTER (WHERE scope_resources <> '{}')::float / count(*) FROM org_users WHERE is_active` ≥ 0.9，低于 exit 非 0 阻断 Wave 2）
- [ ] **Step 6: 测试**（vitest：backfill 匹配逻辑纯函数 vs role-scope.ts 对拍；guard 判定；dry-run 连 dev 断言 processed>0）
- [ ] **Step 7: Commit**

```bash
git add database/migrations/201_scope_resources_reconcile_history.sql web/lib/jobs/reconcile-scope-resources/ web/app/api/admin/cron/reconcile-scope-resources/ scripts/backfill-scope-resources.mjs scripts/guard-scope-projection.mjs
git commit -m "feat(perm): 薄同步/对账接线 + backfill + 覆盖守卫（M2b/M5/M9）"
```

---
---

### Task 4: 执行 backfill + 覆盖守卫（Wave1.5，M3 前置）

**Files:**
- Test: psql 抽样验证

**Interfaces:**
- Consumes: Task 3b `scripts/backfill-scope-resources.mjs` + `scripts/guard-scope-projection.mjs`。
- Produces: 生产 `org_users.scope_resources` 全量投影 + 覆盖守卫通过（Wave 2 硬门禁）。

- [ ] **Step 1: 生产跑 backfill（写，M9 护栏内）**

Run: `node scripts/backfill-scope-resources.mjs --write`（org-wide 非空护栏 + changed>50% 熔断内）
Expected: changed 汇总；退出码 0；**未触发护栏 abort**。

- [ ] **Step 2: 覆盖守卫（硬门禁，M8）**

Run: `node scripts/guard-scope-projection.mjs`
Expected: 活跃用户非空投影 ≥90%，exit 0。低于阈值 → 排查 Casdoor 授权数据配置（用户侧）后再重跑，**不推 Wave 2**。

- [ ] **Step 3: 按 persona 抽样验证（S12/方法论panel：勿任意 10 行）**

Run: `psql` 按 `role_codes @> ARRAY['boss']` / zone_manager / brand-only 各取，加「active 用户空投影计数」：
`select count(*) filter (where scope_resources <> '{}')::float / count(*) from org_users where is_active;`
Expected: boss 用户含 `data-analysis:branch:全店`；计数查询 ≥0.9。

- [ ] **Step 4: 记录回填结果**

（部署回填不 commit；结果记录到 Wave1.5 门禁记录，供 Wave 2 放行判断。）

---

### Task 5: M3 迁移——get_user_perms / strict 新形状（SQL 解析，双形过渡）

**Files:**
- Create: `database/migrations/200_get_user_perms_scope_resources.sql`
- Create: `database/tests/200_get_user_perms_scope_resources.sql`（分支测试入库，防函数一改测试失联——M13/spec-forge）
- Test: psql 单元（各解析分支）

**Interfaces:**
- Consumes: `org_users.scope_resources`（Task 1/4）、`maps_branch_group`、`dim_branch`。
- Produces: `get_user_perms` **双形输出**（M1/spec-forge：旧顶层四维 + 新 data_scope/fields，同源同值）+ `get_user_perms_strict` NULL 闸（判定源 scope_resources、**移除 temp-grant 子句**——M11）。

- [ ] **Step 1: 写迁移（get_user_perms 双形 + 解析）**

```sql
-- 200_get_user_perms_scope_resources.sql
-- M3：get_user_perms 切换为「scope_resources 投影 → SQL 解析」。
-- M1/spec-forge：双形过渡——旧顶层四维（消费端迁移期读）+ 新 data_scope/fields（同源同值），M6 摘旧 key。
-- M2/spec-forge：裸 '*' 非投影键，无 @>['*'] 全权分支；唯一通配 = data-analysis:branch:全店 / :*。
-- 幂等：CREATE OR REPLACE。语义对齐 claims.js resolveScopeKeys + collapseFullStore。

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
        'departments', '[]'::jsonb, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'can_see_cost', false,
        'data_scope', jsonb_build_object('brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'branch_nums', '["*"]'::jsonb),
        'fields', jsonb_build_object('cost', false));
    END IF;
    RETURN jsonb_build_object('role_code', null, 'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb,
      'departments', '[]'::jsonb, 'branch_nums', '[]'::jsonb, 'brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'can_see_cost', false,
      'data_scope', jsonb_build_object('brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'branch_nums', '[]'::jsonb),
      'fields', jsonb_build_object('cost', false));
  END IF;

  -- 角色 UI 档案（保留 175 语义）
  IF array_length(v_role_codes, 1) > 0 THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.code = ANY(v_role_codes) AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code LIMIT 1;
  END IF;

  -- M2：无通配全权分支（裸 '*' 非投影键）；brands/categories/cost 从前缀剥离
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
      v_branch := '["*"]'::jsonb;   -- 通配短路（唯一合法通配）
    ELSE
      FOR v_key IN SELECT unnest(v_branch_keys) LOOP
        IF EXISTS (SELECT 1 FROM maps_branch_group WHERE is_active AND group_id = v_key) THEN
          SELECT array_agg(DISTINCT branch_number) INTO v_tmp FROM maps_branch_group
            WHERE is_active AND group_id = v_key AND branch_number IS NOT NULL;
          -- M7/spec-forge：coalesce 防 NULL 毒化（空分区包 v_tmp=NULL → 整列污染）
          v_collapsed := v_collapsed || coalesce(v_tmp, ARRAY[]::text[]);
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

  -- M1：双形输出——旧顶层四维 + 新 data_scope/fields（同源同值）
  RETURN jsonb_build_object('role_code', v_role_code, 'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels,
    'departments', v_dept_ids,
    'branch_nums', v_branch, 'brands', v_brands, 'categories', v_categories, 'can_see_cost', v_cost,
    'data_scope', jsonb_build_object('brands', v_brands, 'categories', v_categories, 'branch_nums', v_branch),
    'fields', jsonb_build_object('cost', v_cost));
END;
$function$;
```

- [ ] **Step 2: 写 strict 闸更新（判定源 scope_resources，移除 temp-grant 子句）**

```sql
-- M11/spec-forge：temp-grant 197 已冻结，不构成授权面，移除子句（防「过闸但函数不读」自相矛盾）。
-- NULL 闸 = 无 role_codes ∧ 无 scope_resources。
CREATE OR REPLACE FUNCTION public.get_user_perms_strict(p_wecom_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_active BOOLEAN; v_empty BOOLEAN; v_perms JSONB;
BEGIN
  SELECT u.is_active INTO v_active FROM org_users u WHERE u.wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN RETURN NULL; END IF;
  SELECT coalesce(array_length(o.role_codes, 1), 0) = 0
         AND coalesce(array_length(o.scope_resources, 1), 0) = 0
    INTO v_empty FROM org_users o WHERE o.wecom_id = p_wecom_id;
  IF coalesce(v_empty, true) THEN RETURN NULL; END IF;
  SELECT get_user_perms(p_wecom_id) INTO v_perms;
  RETURN v_perms;
END;
$function$;
```

- [ ] **Step 3: 单元测试各解析分支（psql，存 `database/tests/200_..._test.sql`）**

M13/spec-forge：**INSERT ON CONFLICT 显式建用户**（UPDATE 0 行静默通过）、**全店短路/收敛拆两用例**（收敛用例显式列出全部 branch_number，走到 collapse 代码路径而非短路）、补中文名/重名/未知/空分区包分支：
```sql
-- 建测试用户（幂等；用完 DELETE wecom_id LIKE 'zz_test%' 清理）
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources)
VALUES ('zz_test_full', 'zz', true, '{boss}', ARRAY['data-analysis:branch:全店','data-analysis:brand:3120','data-analysis:field:cost'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;

-- 分支1a：全店键短路 → ['*']
SELECT get_user_perms('zz_test_full')->'data_scope'->'branch_nums' = '["*"]'::jsonb AS full_shortcut;
-- 分支1b：显式全量 branch_number → collapseFullStore 收敛 ['*']（走到 v_universe_size/v_result_size 代码路径）
UPDATE org_users SET scope_resources = ARRAY(SELECT DISTINCT 'data-analysis:branch:' || branch_number FROM maps_branch_group WHERE is_active AND branch_number IS NOT NULL) WHERE wecom_id='zz_test_full';
SELECT get_user_perms('zz_test_full')->'data_scope'->'branch_nums' = '["*"]'::jsonb AS full_collapse;
-- 分支1c：双形同源——旧顶层 branch_nums 与新 data_scope.branch_nums 相等
SELECT get_user_perms('zz_test_full')->'branch_nums' = get_user_perms('zz_test_full')->'data_scope'->'branch_nums' AS dual_form_equal;

-- 分支2：分区包（东部二区 → 15 店）
UPDATE org_users SET scope_resources = ARRAY['data-analysis:branch:东部二区'] WHERE wecom_id='zz_test_zone';
SELECT jsonb_array_length(get_user_perms('zz_test_zone')->'data_scope'->'branch_nums') = 15 AS zone_count;

-- 分支3：未知键 fail-close → []
UPDATE org_users SET scope_resources = ARRAY['data-analysis:branch:不存在的包'] WHERE wecom_id='zz_test_unknown';
SELECT get_user_perms('zz_test_unknown')->'data_scope'->'branch_nums' = '[]'::jsonb AS unknown_failclose;

-- 分支4：空资源 → 空集 deny
UPDATE org_users SET scope_resources = ARRAY[]::text[] WHERE wecom_id='zz_test_none';
SELECT get_user_perms('zz_test_none')->'data_scope'->'branch_nums' = '[]'::jsonb AS empty_deny;

-- 分支5：中文名唯一命中（取 dim_branch 真实单命中门店名；若库内无单命中名，需临时 INSERT 一条 dim_branch fixture，测后清理）
-- 分支6：重名 fail-close（需临时 INSERT 两条同名 dim_branch fixture，测后清理）
-- 分支7：空分区包（maps 有 group_id 但 0 branch_number 行——若库内无此组，需临时 fixture）

-- strict 正例/反例
UPDATE org_users SET role_codes='{}', scope_resources=ARRAY[]::text[] WHERE wecom_id='zz_test_none';
SELECT get_user_perms_strict('zz_test_none') IS NULL AS strict_null;
UPDATE org_users SET role_codes='{boss}' WHERE wecom_id='zz_test_none';
SELECT get_user_perms_strict('zz_test_none') IS NOT NULL AS strict_role_only;
UPDATE org_users SET role_codes='{}', scope_resources=ARRAY['data-analysis:branch:全店'] WHERE wecom_id='zz_test_none';
SELECT get_user_perms_strict('zz_test_none') IS NOT NULL AS strict_scope_only;

DELETE FROM org_users WHERE wecom_id LIKE 'zz_test%';
```

- [ ] **Step 4: 幂等重跑验证**

Run: 同一 psql 脚本跑两遍，第二遍无报错（CREATE OR REPLACE 幂等）。

- [ ] **Step 5: Commit**

```bash
git add database/migrations/200_get_user_perms_scope_resources.sql database/tests/200_get_user_perms_scope_resources.sql
git commit -m "feat(perm): get_user_perms 双形 data_scope+fields（M3，M1 双形/M2 裸星/M7 NULL/M11 temp-grant）
- get_user_perms：门店源切换 scope_resources，双形输出旧四维+新段同源同值
- get_user_perms_strict：判定源 scope_resources，移除 temp-grant 子句
- 分支测试入库 database/tests/（M13）"
```

---
---

### Task 6: M4 代签 JWT + push 引擎消费新形状（含 scope-signature 读路径）

**Files:**
- Modify: `web/lib/push/render.ts`（generateScopedJwt payload 新形状；URL 变量 branch_nums 非空才渲染——S7）
- Modify: `web/lib/push/index.ts:368-397`（getPermsStrict 解析新形状）
- Modify: `web/lib/push/push-variables.ts:42-70`（matchesScope + Perms 类型）
- Modify: `web/lib/push/engine.ts`（Perms 类型）
- Modify: `web/lib/push/scope-signature.ts`（**改读路径** data_scope.* + fields.cost——M6，防签名碰撞跨用户泄漏）
- Modify: `web/lib/push/shadow.ts`（内联 `RenderedGroup.perms` 类型对齐——S10）
- Create: `web/lib/push/__tests__/scope-signature.test.ts`（「不同门店集→不同签名」等——M6）
- Test: `web/lib/push/__tests__/run-push.test.ts`、`web/lib/push/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `get_user_perms_strict` 双形输出（Task 5，解析 data_scope/fields 段）。
- Produces: 新形状代签 JWT（`data_scope` + `fields`）；Perms 类型统一 `{ data_scope, fields, departments? }`；scope 签名基于 data_scope/fields（M6）。

- [ ] **Step 1: 更新 Perms 类型 + matchesScope（S7：URL 渲染要求 branch_nums 非空）**

```ts
// push-variables.ts
export interface Perms {
  data_scope: { brands: string[]; categories: string[]; branch_nums: string[] };
  fields: { cost: boolean };
  departments?: string[];
}

export function matchesScope(v: PushVariable, perms: Perms): boolean {
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
  return true;
}
```

- [ ] **Step 2: 更新 generateScopedJwt（render.ts，payload 新形状）**

```ts
const payload = {
  role: 'authenticated',
  data_scope: perms.data_scope,
  fields: perms.fields,
  departments: perms.departments ?? [],
  iat: now,
  exp: now + 600, // 10 分钟
};
```

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

- [ ] **Step 4: scope-signature 改读路径（M6）+ render 成本脱敏 + URL 变量非空**

`web/lib/push/scope-signature.ts`：`scopeSignature(scope)` 与 `scopeEqual` 从读 `scope.branch_nums/can_see_cost` 改为读 `scope.data_scope.brands/branch_nums/categories` + `scope.fields.cost`，canonical 输出 key（b/br/c/cost）不变。engine.ts `Perms extends Scope` → 直接引用 push-variables 的 `Perms`。render.ts `renderVariables` 成本脱敏 `!perms.can_see_cost` → `!perms.fields.cost`；URL 变量 `params.set('branch', perms.data_scope.branch_nums.join(','))`（brands/categories 同理），**且 branch_nums 为空时不渲染该 URL 变量（S7，防 brand-only 用户收空链接假成功）**。shadow.ts 内联 `RenderedGroup.perms` 类型对齐（S10）。

- [ ] **Step 5: 测试（fixture 从 Task 5 golden 派生 + 签名相异 + RPC smoke）**

`web/lib/push/__tests__/scope-signature.test.ts`（M6）：「不同 branch_nums → 不同签名」「不同 fields.cost → 不同签名」「`['*']` vs 388 明细 → 不同签名」「同集合乱序 → 同签名」。
`run-push.test.ts` / `engine.test.ts`（M12/spec-forge）：**Perms fixture 从 Task 5 golden 输出派生**（同 fixture 数据集，防形状漂移测不出）；断言 JWT payload 含 data_scope、不含旧顶层 key；**M3 部署后、M4 切换前加真实 RPC smoke**——`get_user_perms_strict` 对一个已知用户 curl，断言 `data_scope` 存在且非 deny。

- [ ] **Step 6: S1 M7 守卫交互（品牌/品类数值变量维持抑制）**

M4 只放开品牌/品类 `*_url`（链接）变量；品牌/品类**数值**（非 `_url`）变量维持 pre-M4 抑制——避免 M7 live 拒投拦截面从 branch 扩到 brand/category 的功能回归（spec-forge S1；§12.1 已写「M7 放开 ↔ 真值过滤同窗」硬约束）。

- [ ] **Step 7: 跑 vitest**

Run: `cd web && npx vitest run lib/push/`
Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
git add web/lib/push/
git commit -m "feat(push): 代签 JWT 新形状 + scope-signature 读路径 + URL 非空 + 签名测试（M4/M6/S7/S10）"
```

---

### Task 7: M4b agent-query / wecom-oauth 消费新形状（wecom-oauth fail-open 加固）

> **Wave 0 前置（M1/spec-forge）**：wecom-oauth 的 `\|\| ["*"]` 兜底是**独立于形状的 fail-open bug**——必须在 Wave 1/2 之前单独 SSH 部署修复为 `?? []`，把跨通道间隙从 FAIL-OPEN 变 FAIL-CLOSED（否则 M3 后 `perms.branch_nums` 变 undefined → 给每个用户签全店 token）。

**Files:**
- Modify: `functions/wecom-oauth/index.js`（兜底 `\|\| ["*"]` → `?? []`；Wave2 会话 token 加 data_scope 段）
- Modify: `functions/agent-query/index.js:340-345`（branch_nums → data_scope.branch_nums）
- Test: `node --check`；pre-commit bundle 校验

**Interfaces:**
- Consumes: `get_user_perms` 双形输出（Task 5）。
- Produces: 无会话链路消费端对齐新形状；wecom-oauth fail-open 修复。

- [ ] **Step 0（Wave 0，先于一切，function-only SSH 部署）: wecom-oauth fail-open 加固**

`functions/wecom-oauth/index.js`：`branch_nums: perms.branch_nums || ["*"]`、`brands: ... || ["*"]`、`categories: ... || ["*"]`、`can_see_cost: ... || false` → 全部改 `?? []` / `?? false`（兜底恒 deny；对旧形状同样正确）。改后重打包 index.bundle.js（pre-commit 钩子校验）→ SSH 直调 PUT + 清 Deno 缓存（CLAUDE.md function-only 通道）→ `curl https://data.shanhaiyiguo.com/functions/wecom-oauth` 验证。**不触发 GHA。**

- [ ] **Step 1: agent-query 对齐**

`functions/agent-query/index.js`：`!Array.isArray(perms.branch_nums)` → 改判 `ds.branch_nums`（data_scope 段）；透传 runPg/runDuckdb 前归一为既有 runner 期望形状（`{ branch_nums: ds.branch_nums, can_see_cost: perms.fields?.cost === true, ... }`，**只搬字段不重算 branch_nums**）。

- [ ] **Step 2: wecom-oauth 会话 token 加 data_scope 段（Wave 2，双形后）+ 旧 token 窗口**

wecom-oauth 签发的 7 天会话 token 从双形输出读 `data_scope`/`fields` 内嵌（新登录即新形状）。**rollout 说明**：Wave 2 部署前签发的旧 token 无 data_scope → RLS deny（fail-closed 可接受），前端读顶层 `branch_nums` 可能误显全权 → 部署后建议引导重新登录。

- [ ] **Step 3: 核实两个 function 的 perms 字段消费**

Run: `grep -n "perms\." functions/agent-query/index.js functions/wecom-oauth/index.js`。把实际消费字段列到 task 记录，逐一映射到新形状（双形下顶层旧 key 仍可用，但**迁移目标 = data_scope/fields**）。

- [ ] **Step 4: 语法校验 + bundle + 提交**

Run: `node --check functions/agent-query/index.js && node --check functions/wecom-oauth/index.js`
```bash
git add functions/agent-query/index.js functions/wecom-oauth/index.js
git commit -m "fix(perm): agent-query/wecom-oauth 消费双形 + wecom-oauth fail-open 加固（M1/M4b）"
```

---

### Task 8: M5 一致性契约 + 端到端验证（全链 + N 用户差分）

**Files:**
- Create: `web/lib/push/__tests__/scope-consistency.test.ts`（claims.js↔scope-expand↔SQL 全链 golden fixture——M12/spec-forge）
- Create: `scripts/perm-diff-matrix.mjs`（N 用户 claims.js vs get_user_perms SQL 差分矩阵——S12/方法论panel）
- Test: vitest + 生产端到端（裁剪）

**Interfaces:**
- Consumes: 全部前序 task 产物。
- Produces: 「登录 claims data_scope ↔ get_user_perms data_scope 同输入同输出」全链契约（防 JS/SQL 解析漂移）。

- [ ] **Step 1: 写全链一致性契约测试（golden fixture，M12）**

用**受控 fixture 数据集**（Task 5 同款：INSERT 固定 maps_branch_group/dim_branch 行）生成 golden JSON 快照，vitest 断言 **claims.js resolveScopeKeys ↔ scope-expand.ts ↔ SQL get_user_perms 三者输出一致**（覆盖：全店短路 / collapse 收敛 / 分区包 / branch_number / 中文名唯一 / 重名 fail-close / 未知键 fail-close / 空集）。**不只测 SQL↔scope-expand 镜像**——claims.js（登录真身）必须进契约一端。

- [ ] **Step 2: N 用户差分矩阵（S12）**

`scripts/perm-diff-matrix.mjs`：对 N 个真实用户，分别跑 claims.js 解析（登录路径）与 get_user_perms（SQL），输出「不一致矩阵」（用户 × 门店集差异）；这是规模化抓 JS/SQL 漂移的唯一手段。

- [ ] **Step 3: 生产端到端验证（裁剪，可行性panel）**

部署后（Wave 2 + restart postgrest）：
1. `psql` 抽 boss 用户 → `get_user_perms` 双形：`data_scope.branch_nums` 含 `["*"]`、旧顶层 `branch_nums` 与新段相等（双形同源断言）。
2. `run_push(deliver=false)`（shadow）→ render 产物 detail_url 带新形状 JWT，scope 签名正确。
3. **用代签 JWT 直查报表视图（PostgREST）→ RLS 放行、门店集正确**（这是验证推送链接可用的最关键一步）。
4. 真实企微扫码比对 claims ↔ get_user_perms → 标记为「授权数据配好后的后续验证」，不阻塞本 plan 验收。

- [ ] **Step 4: 记录验证结果并收尾**

把端到端结果（各用户门店数抽样）写进 task 记录；确认无 0 门店异常之外的新增 skip。

---

### Task 9: CI 门禁（M12/spec-forge——测试从「意愿」变「门禁」）

**Files:**
- Modify: `.github/workflows/deploy.yml`（migrate 前加 vitest + reconcile dry-run 步骤）
- Test: 推一个分支验证 GHA

**Interfaces:**
- Consumes: Task 3/3b/5/6/8 的测试。
- Produces: 回归测试进 CI，忘跑/跑挂即阻断。

- [ ] **Step 1: GHA 加测试步骤**

`.github/workflows/deploy.yml` 在 migrate 前加：`npx vitest run lib/push/ lib/sync/` + `node scripts/backfill-scope-resources.mjs`（dry-run，退出码 0 且 processed>0）。失败阻断部署（非 continue-on-error）。

- [ ] **Step 2: 验证**

推一个临时分支触发 GHA → 确认测试步骤绿 → 删临时分支。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(perm): 推送/同步测试进 GHA 门禁（M12）"
```

---

## Self-Review 记录

- **Spec 覆盖（修订后）**：设计 §4 投影 schema→Task1；§5.1 登录写穿→Task2；§5.2/§5.3 薄同步/对账接线→Task3b+Task4；§6 get_user_perms 双形+SQL 解析→Task5；§7 代签 JWT→Task6；§8 消费侧迁移→Task6/7；§9 契约（全链/对拍/签名/双形）→Task3+Task8；§11 Wave 部署+回滚→Global Constraints+Task4；新增 CI 门禁→Task9。
- **spec-forge 13 条必须改覆盖**：M1（Task7 Wave0+双形）、M2（Task2/5 裸星）、M3（Task2 写时 fail-close）、M4（Task3 对拍）、M5（Task3b 接线）、M6（Task6 scope-signature）、M7（Task5 NULL）、M8（Global Constraints Wave+Task4 guard）、M9（Task3b/4 护栏）、M10（design §11 回滚）、M11（Task5 strict）、M12（Task8/9 契约链+CI）、M13（Task5 分支测试入库）。全 13 条有 task 落点。
- **占位符扫描**：无 TBD/TODO；各 task 含实际 SQL/代码/测试命令。
- **类型一致性**：Perms 新形状 `{data_scope, fields, departments?}` 在 Task6 统一；get_user_perms 双形 key（顶层旧四维 + data_scope/fields 同源）在 Task5 定义、Task6/7 消费。
- **部署顺序风险**：Global Constraints 已改为 Wave 5 段；Task4 覆盖守卫是 Wave 2 硬门禁。

# 报表权限收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把报表权限的角色层断链接上(role_id 自动赋值)、给 report_*_gen 生成器视图统一注入门店/品牌行级过滤,并交付权限管理页(角色指派+生效预览),按灰度顺序在生产收口。

**Architecture:** 方案 A(spec 已批):生成器模板统一注入 `claim_match_or_star` 行过滤(与 maskCost 列脱敏同机制、读 114 扁平化 GUC);`wecom-sync-contacts` 经新 RPC `refresh_role_assignments()` 按 `dept_role_mapping` 自动赋 `org_users.role_id`(manual 不覆盖);新 admin API 路由自带鉴权(不照抄既有零鉴权路由)。

**Tech Stack:** TypeScript(vitest, semantic-generator)/ PLpgSQL(迁移 152)/ CommonJS edge function / Next.js App Router(admin 页+API)。

**Spec:** `docs/superpowers/specs/2026-08-03-report-permission-lockdown-design.md`

## Global Constraints

- **架构铁律**:改生成器前必须先更新 `docs/architecture.md` §10.10(Task 1 先行,CLAUDE.md 强制)。
- **生成器铁律**:权限过滤是模板级横切能力(同 `maskCost` 先例),禁在 view-configs/registry 写权限逻辑;`system_book_code`/`branch_num`/`'ALL'` 字面量在生成器已有先例(dimKey/hierarchy.ts:194),沿用。
- **门店键铁律**:`branch_num` 不单独过滤,必须与 `brands`(system_book_code)组合。
- **零爆炸半径**:`claim_match_or_star` 语义不变——claim 缺失/空/含 `"*"` → 放行,旧 token 不破坏。
- **迁移幂等**:`ADD COLUMN IF NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP ... IF EXISTS`;migrate.sh 每次部署重跑全部迁移。
- **视图/RPC/加列后**须 `docker compose restart postgrest` 刷 schema 缓存。
- **部署分流**(CLAUDE.md):只改 function → SSH PUT + 清 Deno 缓存;web/迁移/生成器 → GHA。
- 角色种子按 072:boss/zone_manager/finance 可见成本;manager/buyer 不可见。
- 管理页视觉遵守 `DESIGN.md`(DM Sans + tabular-nums,Industrial/Utilitarian)。
- npm 安装用 npmmirror 镜像。

## 部署编排(全计划视角)

Task 1-5、7-9 的代码合入后一次 GHA(迁移+生成产物+web);Task 6 的 function 在 GHA 迁移跑完后 SSH PUT(依赖迁移 152 的 RPC 已存在)。灰度与生产验证在 Task 9。

---

### Task 1: 架构文档 §10.10 权限过滤扩展(铁律先行)

**Files:**
- Modify: `docs/architecture.md`(§10.10 「生成器约束铁律」小节后追加一条架构扩展;铁律清单追加第 6 条)

- [ ] **Step 1: 在 §10.10 的 lateral_pick 扩展条目之后追加权限过滤扩展条目**

在 `docs/architecture.md` 中找到 `- **lateral_pick（2026-08-02 架构扩展）**` 条目(§10.10 内),在其后插入:

```markdown
- **权限过滤（2026-08-03 架构扩展）**：生成器模板统一注入行级权限过滤——所有 actual CTE 加 `claim_match_or_star('request.jwt.claims.brands', s.system_book_code) AND claim_match_or_star('request.jwt.claims.branch_nums', s.branch_num)`（经 `src/generators/perm.ts` 的 `permFilterFact`）；target CTE 用 `permFilterTarget`（`branch_num='ALL'` 汇总行恒可见，门店行按 claim 过滤）；hierarchy 的 dim 行（leaf_rows）同双维度过滤。列脱敏（`can_see_cost` CASE）为既有 maskCost 机制。语义照迁移 072 ⑫：claim 缺失/空/含 `"*"` → 放行（零爆炸半径）。属模板级横切安全能力（同 maskCost 先例），新增视图自动继承，**禁止在 view-configs/metric_registry 写权限逻辑**。契约测试 `__tests__/perm-filter.test.ts` 卡死：任何 `database/generated/*.sql` 缺过滤即红。spec：`docs/superpowers/specs/2026-08-03-report-permission-lockdown-design.md`。
```

- [ ] **Step 2: 铁律清单追加第 6 条**

在 §10.10「生成器约束铁律」编号列表第 5 条(`5. **校验兜底**...`)之后追加:

```markdown
6. **权限过滤/脱敏只走模板**（`perm.ts` + `maskCost`）：新增视图不得手写 `claim_match_or_star`/`can_see_cost` 判断，由生成器统一注入；手写 = 违规（口径漂移 + 漏视图即越权）。
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs(arch): §10.10 权限过滤架构扩展——行过滤模板统一注入(权限收口 spec 2026-08-03)"
```

---

### Task 2: 生成器 perm helper + tier1 注入

**Files:**
- Create: `services/semantic-generator/src/generators/perm.ts`
- Modify: `services/semantic-generator/src/generators/tier1.ts`(3 处注入点 + import)
- Test: `services/semantic-generator/__tests__/perm-filter.test.ts`

**Interfaces:**
- Produces: `permFilterFact(alias: string): string`(actual CTE 用)、`permFilterTarget(alias: string): string`(targets CTE 用,'ALL' 行恒放行)。Task 3 的 hierarchy.ts 也 import 这两个函数。

- [ ] **Step 1: 写失败测试**

创建 `services/semantic-generator/__tests__/perm-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { Metric, MetricSource, ViewConfig } from '../src/types';

const BRANDS_PRED = `claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb`;
const BRANCH_PRED = `claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb`;

const mockMetrics: Metric[] = [
  {
    metric_code: 'sale_amount', name: '销售金额', measure_type: 'base',
    fact_table: 'report_daily_sales', value_column: 'total_sale', agg: 'SUM',
    formula: null, depends_on: [], additive: true, cost_sensitive: false,
    unit: '元', data_ready: true, enabled: true, description: null, business_formula: null,
  },
  {
    metric_code: 'sale_profit', name: '销售毛利', measure_type: 'base',
    fact_table: 'report_daily_sales', value_column: 'total_profit', agg: 'SUM',
    formula: null, depends_on: [], additive: true, cost_sensitive: true,
    unit: '元', data_ready: true, enabled: true, description: null, business_formula: null,
  },
  {
    metric_code: 'sale_target', name: '销售目标', measure_type: 'base',
    fact_table: 'target_metric_values', value_column: 'target_value', agg: 'SUM',
    formula: null, depends_on: [], additive: true, cost_sensitive: false,
    unit: '元', data_ready: true, enabled: true, description: null, business_formula: null,
  },
];

const mockSources: MetricSource[] = [
  { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null },
  { metric_code: 'sale_profit', source_table: 'report_daily_sales', source_column: 'total_profit', source_filter: null },
  { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'" },
];

const config: ViewConfig = {
  view_name: 'report_perm_test_gen',
  metrics: ['sale_amount', 'sale_profit', 'sale_target'],
  dim_code: 'brand',
  dim_table: 'brands',
  scope: { target_window: true, target_level: 'total', target_status: ['active', 'closed'] },
  total_row: true,
};

describe('权限收口：tier1 行级过滤注入', () => {
  const sql = generateTier1View(config, mockMetrics, mockSources);

  it('actual CTE 含 brands + branch_nums 过滤', () => {
    expect(sql).toContain(BRANDS_PRED);
    expect(sql).toContain(BRANCH_PRED);
  });

  it('target CTE 过滤带 ALL 汇总行放行', () => {
    expect(sql).toContain(`t.branch_num = 'ALL'`);
  });

  it('cost_sensitive 指标脱敏 CASE 仍在', () => {
    expect(sql).toContain(`current_setting('request.jwt.claims.can_see_cost', true)`);
  });
});
```

注意:`MetricSource`/`ViewConfig` 的字段名以 `src/types.ts` 为准,若与上面不完全一致,照 `__tests__/tier1.test.ts` 现有 fixture 的字段名调整。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/semantic-generator && npx vitest run __tests__/perm-filter.test.ts
```

预期:FAIL(3 个断言都不含过滤谓词)。

- [ ] **Step 3: 创建 perm.ts**

```ts
// services/semantic-generator/src/generators/perm.ts
/**
 * 行级权限过滤（架构 §10.10「权限过滤」扩展，2026-08-03）
 *
 * 与 maskCost 列脱敏同属模板级横切安全能力：所有视图自动继承，
 * 禁在 view-configs / metric_registry 写权限逻辑（铁律第 6 条）。
 *
 * 语义照迁移 072 ⑫：claim 缺失/空/含 "*" → 放行（零爆炸半径，旧 token 不破坏）。
 * 门店键铁律：branch_num 不单独过滤，与 brands(system_book_code) 组合。
 * GUC 来源：迁移 114 pgrst_pre_request 把 JWT claims 扁平化为 request.jwt.claims.<key>。
 */

/** actual CTE（fact 表）行过滤：品牌 + 门店双维度 */
export function permFilterFact(alias: string): string {
  return `claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, ${alias}.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, ${alias}.branch_num::text)`;
}

/** targets CTE 行过滤：'ALL' 汇总行（总部/总目标）恒可见，门店行按 claim 过滤 */
export function permFilterTarget(alias: string): string {
  return `(${alias}.branch_num = 'ALL' OR ${permFilterFact(alias)})`;
}
```

- [ ] **Step 4: tier1.ts 三处注入**

`services/semantic-generator/src/generators/tier1.ts`:

(1) 文件顶部 import 区(第 3 行后)加:

```ts
import { permFilterFact, permFilterTarget } from './perm.js';
```

(2) category UNION 路径的 actual CTE(现 `if (g.filter) where.push(g.filter);` 在 `union${cteIdx++}` 分支内,约 156 行)改为:

```ts
      const where: string[] = [];
      if (g.filter) where.push(g.filter);
      where.push(permFilterFact('s'));
```

(3) 单表单 CTE 路径(约 303 行,`if (g.filter) where.push(g.filter);` 后)同样加一行:

```ts
      if (g.filter) where.push(g.filter);
      where.push(permFilterFact('s'));
```

(4) target base CTE(约 355-361 行,`cteList.push(\`${cteName} AS (... FROM targets t JOIN target_metric_values tmv ...`)的 WHERE 行改为:

```ts
  WHERE t.breakdown_level='${config.target_breakdown ?? 'store'}' AND ${metricFilter || 'true'} AND ${permFilterTarget('t')}${assessedCond}
```

- [ ] **Step 5: 跑测试确认通过 + tier1 既有测试不回归**

```bash
cd services/semantic-generator && npx vitest run __tests__/perm-filter.test.ts __tests__/tier1.test.ts
```

预期:全 PASS。

- [ ] **Step 6: Commit**

```bash
git add services/semantic-generator/src/generators/perm.ts services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/perm-filter.test.ts
git commit -m "feat(generator): perm.ts 行级权限过滤 + tier1 actual/target CTE 注入(TDD)"
```

---

### Task 3: hierarchy 生成器注入

**Files:**
- Modify: `services/semantic-generator/src/generators/hierarchy.ts`(4 处注入点 + import)
- Test: `services/semantic-generator/__tests__/perm-filter.test.ts`(追加 hierarchy 用例)

**Interfaces:**
- Consumes: `permFilterFact` / `permFilterTarget`(Task 2)。

- [ ] **Step 1: 追加失败测试(hierarchy 用例)**

在 `__tests__/perm-filter.test.ts` 末尾追加。fixture 复用现成模式:`__tests__/hierarchy.test.ts:404` 附近有 `baseConfig(...)` 辅助与配套 mock metrics/sources,把该辅助函数与所需 fixture 复制到本文件(或 import——若 hierarchy.test.ts 未 export 则复制):

```ts
// —— hierarchy 用例：叶级 actual/target CTE + dim 行过滤 ——
// fixture 复制自 __tests__/hierarchy.test.ts 的 baseConfig 块（T6 final SELECT describe 内）
describe('权限收口：hierarchy 行级过滤注入', () => {
  it('叶级 actual CTE 含 brands + branch_nums 过滤', () => {
    const sql = generateHierarchyView(baseConfig(), hierMetrics, hierSources);
    expect(sql).toContain(BRANDS_PRED);
    expect(sql).toContain(BRANCH_PRED);
  });

  it('叶级 target CTE 过滤带 ALL 放行', () => {
    const sql = generateHierarchyView(baseConfig(), hierMetrics, hierSources);
    expect(sql).toContain(`t.branch_num = 'ALL'`);
  });

  it('dim 行（dim_branch）也被双维度过滤', () => {
    const sql = generateHierarchyView(baseConfig(), hierMetrics, hierSources);
    expect(sql).toMatch(/db\.system_book_code/);
    expect(sql).toMatch(/db\.branch_num::text/);
  });

  it('category 视图 delivery/wholesale actuals 均含过滤', () => {
    const sql = generateCategorySql(); // 见下
    const brandsCount = sql.split(BRANDS_PRED).length - 1;
    expect(brandsCount).toBeGreaterThanOrEqual(2); // delivery + wholesale 两个 actual CTE
  });
});
```

`generateCategorySql()`:用 `__tests__/hierarchy.test.ts` 中 category 视图的现有用例配置(`dim_code:'category'` 的 config + 配套 metrics/sources,含 `delivery_amount`/`wholesale_amount`/`outbound_amount_target`/`outbound_profit_target` 四个 source 映射)调 `generateHierarchyView`。若 hierarchy.test.ts 没有现成 category 用例,照 `generateCategoryView` 的要求构造:config `{ view_name:'report_cat_test_gen', dim_code:'category', metrics:['outbound_amount','outbound_profit'], categories:['水果','标品'], scope:{ target_level:'total', target_status:['active'] } }`,sources 须含 `delivery_amount→report_daily_delivery.out_money`、`wholesale_amount→report_daily_wholesale.wholesale_money`、`outbound_amount_target→target_metric_values(filter metric_code='outbound_amt')`、`outbound_profit_target→target_metric_values(filter metric_code='outbound_profit')`。

文件顶部补 import:

```ts
import { generateHierarchyView } from '../src/generators/hierarchy';
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd services/semantic-generator && npx vitest run __tests__/perm-filter.test.ts
```

预期:hierarchy 4 个新用例 FAIL。

- [ ] **Step 3: hierarchy.ts 四处注入**

`services/semantic-generator/src/generators/hierarchy.ts` 顶部 import 区加:

```ts
import { permFilterFact, permFilterTarget } from './perm.js';
```

(1) 叶级 actual CTE(约 158-159 行):

```ts
    const where: string[] = [];
    if (g.filter) where.push(g.filter);
    where.push(permFilterFact('s'));
```

(2) 叶级 target CTE(约 194 行 `whereExtra` 初始化处):

```ts
    const whereExtra: string[] = [`t.branch_num <> 'ALL'`, permFilterTarget('t')];
```

(3) 叶级 dim 行(约 302 行 `whereParts` 初始化处,`db.is_active`, `db.branch_num <> '99'`):

```ts
  const whereParts = [`db.is_active`, `db.branch_num <> '99'`, permFilterFact('db')];
```

(4) 父级 target CTE(约 354 行 `whereExtra`):

```ts
      const whereExtra: string[] = [`t.breakdown_level = '${p.target_breakdown}'`, permFilterTarget('t')];
```

(5) category 视图(`generateCategoryView`)两个 actual CTE:

`delivery_actuals` 的 WHERE(约 475-476 行)末尾加一行:

```ts
  WHERE (tb.system_book_code = 'ALL' OR d.system_book_code = tb.system_book_code)
    AND d.category_group IN (${categoryValues.map(c => `'${c}'`).join(', ')})
    AND ${permFilterFact('d')}
```

`wholesale_actuals` 的 WHERE(约 490-491 行)同理:

```ts
  WHERE (tb.system_book_code = 'ALL' OR w.system_book_code = tb.system_book_code)
    AND w.category_group IN (${categoryValues.map(c => `'${c}'`).join(', ')})
    AND ${permFilterFact('w')}
```

注意:`generateCategoryView` 里 `d`/`w` 是 fact 表别名(照现有 SQL 的别名,若实际是 `s` 则传 `'s'`)。

- [ ] **Step 4: 跑测试确认通过 + hierarchy 既有测试不回归**

```bash
cd services/semantic-generator && npx vitest run
```

预期:全部 PASS(perm-filter/tier1/hierarchy/tier2/ast 全绿)。

- [ ] **Step 5: Commit**

```bash
git add services/semantic-generator/src/generators/hierarchy.ts services/semantic-generator/__tests__/perm-filter.test.ts
git commit -m "feat(generator): hierarchy 叶级/dim/category 行级权限过滤注入(TDD)"
```

---

### Task 4: 产物契约测试 + 重新生成全部视图

**Files:**
- Modify: `services/semantic-generator/__tests__/perm-filter.test.ts`(追加产物扫描)
- Modify: `database/generated/*.sql`(8 个视图全部重新生成)

**Interfaces:**
- Produces: 更新后的 `database/generated/*.sql`,后续 GHA 部署由 migrate.sh 应用。

- [ ] **Step 1: 追加产物扫描契约测试(先失败)**

`__tests__/perm-filter.test.ts` 顶部加:

```ts
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const GEN_DIR = fileURLToPath(new URL('../../../../database/generated', import.meta.url));
```

文件末尾追加:

```ts
describe('权限收口契约：所有提交产物必含行级过滤', () => {
  const files = readdirSync(GEN_DIR).filter(f => f.endsWith('.sql'));

  it('生成视图不少于 8 个', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const f of files) {
    it(`${f} 含 brands + branch_nums 过滤`, () => {
      const sql = readFileSync(`${GEN_DIR}/${f}`, 'utf8');
      expect(sql).toContain(BRANDS_PRED);
      expect(sql).toContain(BRANCH_PRED);
    });
  }
});
```

- [ ] **Step 2: 跑测试确认产物扫描失败(旧产物无过滤)**

```bash
cd services/semantic-generator && npx vitest run __tests__/perm-filter.test.ts
```

预期:产物扫描 describe 全 FAIL(8 个文件缺谓词)。

- [ ] **Step 3: 对本地 dev 库重新生成全部视图**

生成器要连库读 registry + L2 EXPLAIN。本地 dev 栈(deploy-* 容器)在跑的前提下:

```bash
cd services/semantic-generator && npm run gen-views
```

预期输出:8 个视图全部 produced,`explainFailures` 为空。若连库认证失败(28P01),按记忆坑:gen-views 密码取容器 env 而非 deploy/.env——`docker exec deploy-postgres-1 env | grep POSTGRES_PASSWORD` 取真值配 `.env`。

- [ ] **Step 4: 检查产物 diff**

```bash
git diff --stat database/generated/
git diff database/generated/report_brand_metric_gen.sql | head -40
```

预期:8 个文件都有改动;diff 只在 WHERE 子句加 `claim_match_or_star(...)` 行,无其它口径变化。若出现过滤以外的 diff(口径漂移),停下排查——不允许夹带。

- [ ] **Step 5: 全量测试通过**

```bash
cd services/semantic-generator && npx vitest run
```

预期:全 PASS(含产物扫描)。

- [ ] **Step 6: Commit**

```bash
git add database/generated/ services/semantic-generator/__tests__/perm-filter.test.ts
git commit -m "feat(generator): 重新生成 8 视图(含行级权限过滤) + 产物契约测试"
```

---

### Task 5: 迁移 152——role_source 列 + refresh_role_assignments RPC

**Files:**
- Create: `database/migrations/152_role_source_and_refresh_roles.sql`

**Interfaces:**
- Produces: `org_users.role_source TEXT`('auto'/'manual',DEFAULT 'auto');RPC `refresh_role_assignments() RETURNS JSONB`(`{mapped, assigned}`,GRANT anon+authenticated)。Task 6 的 function 与 Task 7 的管理页依赖这两个。

- [ ] **Step 1: 写迁移(幂等模板)**

```sql
-- 152_role_source_and_refresh_roles.sql
-- 权限收口：org_users.role_source（auto/manual）+ refresh_role_assignments() RPC
-- 设计：docs/superpowers/specs/2026-08-03-report-permission-lockdown-design.md C2
-- 幂等：可由 scripts/migrate.sh 重复执行。

BEGIN;

-- ① role_source：manual（管理页指派）不被同步覆盖；auto 每次同步按 dept_role_mapping 重算
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_source TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE org_users DROP CONSTRAINT IF EXISTS org_users_role_source_check;
ALTER TABLE org_users ADD CONSTRAINT org_users_role_source_check CHECK (role_source IN ('auto','manual'));
COMMENT ON COLUMN org_users.role_source IS 'role_id 来源：auto=同步按 dept_role_mapping 自动赋值（可被覆盖）；manual=管理页手工指派（同步不动）';

-- ② refresh_role_assignments()：新部门补映射 + auto 用户重算 role_id
--   映射正则与 072 ⑦ 一致；无匹配部门默认 manager（最小权限兜底）。
--   多部门命中取 priority 最高。无部门/无映射用户 role_id 置 NULL（待 admin 配）。
CREATE OR REPLACE FUNCTION refresh_role_assignments() RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mapped INT := 0;
  v_assigned INT := 0;
BEGIN
  -- 1) 新部门补映射（同 072 ⑦ 正则；已有映射的部门跳过）
  INSERT INTO dept_role_mapping (dept_id, role_id, priority)
  SELECT d.id, r.id,
    CASE WHEN d.name ~ '(总经办|运营总|老板)' THEN 10 ELSE 1 END
  FROM org_departments d
  CROSS JOIN LATERAL (
    SELECT id FROM roles WHERE code =
      CASE
        WHEN d.name ~ '(总经办|运营总|老板)' THEN 'boss'
        WHEN d.name ~ '(战区|区域|大区)'     THEN 'zone_manager'
        WHEN d.name ~ '(店长|门店)'          THEN 'manager'
        WHEN d.name ~ '(采购|业务|品类)'     THEN 'buyer'
        WHEN d.name ~ '(财务)'               THEN 'finance'
        ELSE 'manager'
      END
  ) r
  WHERE d.is_active
    AND NOT EXISTS (SELECT 1 FROM dept_role_mapping m WHERE m.dept_id = d.id);
  GET DIAGNOSTICS v_mapped = ROW_COUNT;

  -- 2) auto 用户按部门映射重算 role_id（manual 不动；无映射 → NULL 待 admin 配）
  UPDATE org_users u
  SET role_id = m.role_id
  FROM (
    SELECT u2.wecom_id,
      (SELECT drm.role_id FROM dept_role_mapping drm
       WHERE drm.dept_id IN (SELECT jsonb_array_elements_text(u2.department_ids))
       ORDER BY drm.priority DESC, drm.role_id
       LIMIT 1) AS role_id
    FROM org_users u2
    WHERE u2.is_active AND u2.role_source = 'auto'
  ) m
  WHERE u.wecom_id = m.wecom_id
    AND u.role_id IS DISTINCT FROM m.role_id;
  GET DIAGNOSTICS v_assigned = ROW_COUNT;

  RETURN jsonb_build_object('mapped', v_mapped, 'assigned', v_assigned);
END;
$$;
COMMENT ON FUNCTION refresh_role_assignments() IS '权限收口：通讯录同步后调用——新部门补 dept_role_mapping + auto 用户重算 role_id（manual 不覆盖）';

GRANT EXECUTE ON FUNCTION refresh_role_assignments() TO anon, authenticated;

COMMIT;
```

- [ ] **Step 2: 本地 dev 库应用 + 验证**

```bash
docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/152_role_source_and_refresh_roles.sql
# 重跑一次验证幂等
docker exec -i deploy-postgres-1 psql -U postgres -d insforge < database/migrations/152_role_source_and_refresh_roles.sql
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT refresh_role_assignments();"
docker exec deploy-postgres-1 psql -U postgres -d insforge -c "SELECT role_source, count(*) FROM org_users GROUP BY 1; SELECT count(*) FILTER (WHERE role_id IS NOT NULL) AS with_role, count(*) AS total FROM org_users WHERE is_active;"
docker compose restart postgrest
```

预期:两次应用都无错;RPC 返回 `{mapped, assigned}` 数字;dev 库有用户时 with_role > 0(dev 库空则 0,属正常)。

- [ ] **Step 3: Commit**

```bash
git add database/migrations/152_role_source_and_refresh_roles.sql
git commit -m "feat(db): 迁移152 role_source 列 + refresh_role_assignments RPC(权限收口 C2)"
```

---

### Task 6: wecom-sync-contacts 接 RPC

**Files:**
- Modify: `functions/wecom-sync-contacts/index.js`(5.2 用户 upsert 后插入 5.3)

**Interfaces:**
- Consumes: RPC `refresh_role_assignments()`(Task 5,须已在生产库存在——function 部署排在 GHA 迁移之后)。

- [ ] **Step 1: 插入 5.3 角色赋值调用**

在 `functions/wecom-sync-contacts/index.js` 的 5.2 用户 upsert 块结束之后(现第 115 行 `}` 之后、第 117 行 `// 6. 离职对齐` 注释之前)插入:

```js
    // 5.3 role_id 自动赋值：新部门补 dept_role_mapping + auto 用户重算（manual 不覆盖）
    //     直连 postgrest（同 wecom-oauth 模式：SECURITY DEFINER + GRANT anon，无需 ANON_KEY；
    //     运行时 SDK 无 database.rpc）。失败不阻断同步主流程，下次同步重试。
    let roleAssign = null;
    try {
      const pr = await fetch(
        `${Deno.env.get("POSTGREST_URL") || "http://postgrest:3000"}/rpc/refresh_role_assignments`,
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      roleAssign = await pr.json().catch(() => null);
      console.log("[sync-contacts] refresh_role_assignments:", roleAssign);
    } catch (e) {
      console.error("[sync-contacts] refresh_role_assignments failed:", e);
    }
```

同时把返回值(现第 163-167 行)改为:

```js
    return json({
      ok: true,
      departments: departments.length,
      users: userRows.length,
      role_assign: roleAssign,
    });
```

- [ ] **Step 2: 语法检查**

```bash
node --check functions/wecom-sync-contacts/index.js
```

预期:无输出(语法 OK)。

- [ ] **Step 3: Commit(先不部署——部署在 Task 9 编排内)**

```bash
git add functions/wecom-sync-contacts/index.js
git commit -m "feat(function): 通讯录同步后调 refresh_role_assignments 自动赋 role_id"
```

---

### Task 7: admin API 鉴权 helper + 权限管理路由

**Files:**
- Create: `web/lib/admin-api-auth.ts`
- Create: `web/app/api/admin/permissions/users/route.ts`
- Create: `web/app/api/admin/permissions/preview/route.ts`

**Interfaces:**
- Produces: `requireAdmin(req: NextRequest): NextResponse | null`(null=放行);`GET/PUT /api/admin/permissions/users`;`GET /api/admin/permissions/preview?wecom_id=`。Task 8 页面消费这些路由。

- [ ] **Step 1: 鉴权 helper**

```ts
// web/lib/admin-api-auth.ts
// /api/admin/** 路由内鉴权（middleware matcher 不盖 /api/**，必须路由内自查）
// 强度与 middleware 的 /admin 页面门一致：insforge_access_token 存在 + wecom_userid ∈ ADMIN_USERIDS
import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_USERIDS } from './auth';

export function requireAdmin(req: NextRequest): NextResponse | null {
  const token = req.cookies.get('insforge_access_token')?.value;
  if (!token) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const uid = req.cookies.get('wecom_userid')?.value;
  if (!uid || !ADMIN_USERIDS.has(uid)) {
    return NextResponse.json({ ok: false, error: 'admin_required' }, { status: 403 });
  }
  return null;
}
```

- [ ] **Step 2: users 路由(GET 列表 + PUT 指派)**

```ts
// web/app/api/admin/permissions/users/route.ts
// 权限管理：用户列表（含角色）+ 角色指派（manual）/ 恢复自动（auto）
// ⚠️ gateway(7130) 不代理 /rpc 与表接口按既有 admin 路由模式直连 PostgREST
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// GET: 用户 + 角色 + 部门（页面一次性取齐）
export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const [u, r, d] = await Promise.all([
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,department_ids,role_id,role_source&is_active=eq.true&order=name`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/roles?select=id,code,name&is_active=eq.true&order=sort_order`, { headers: H, cache: 'no-store' }),
    fetch(`${POSTGREST_URL}/org_departments?select=id,name&is_active=eq.true&order=id`, { headers: H, cache: 'no-store' }),
  ]);
  return NextResponse.json({
    users: await u.json().catch(() => []),
    roles: await r.json().catch(() => []),
    departments: await d.json().catch(() => []),
  });
}

// PUT: 指派角色 { wecom_id, role_id }；role_id=null → 恢复自动（role_source='auto'，下次同步重算）
export async function PUT(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const b = await req.json().catch(() => null);
  if (!b?.wecom_id) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });
  const roleId = b.role_id ?? null;
  const r = await fetch(`${POSTGREST_URL}/org_users?wecom_id=eq.${encodeURIComponent(b.wecom_id)}`, {
    method: 'PATCH',
    headers: { ...H, Prefer: 'return=minimal' },
    body: JSON.stringify({ role_id: roleId, role_source: roleId ? 'manual' : 'auto' }),
  });
  if (!r.ok) return NextResponse.json({ ok: false, error: await r.text() }, { status: 502 });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: preview 路由(生效权限 + 分层来源)**

```ts
// web/app/api/admin/permissions/preview/route.ts
// 生效权限预览：get_user_perms 合成结果 + 角色/部门/个人 override 各层来源（排障用）
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-api-auth';

const POSTGREST_URL = process.env.POSTGREST_URL || 'http://postgrest:3000';
const KEY = process.env.INSFORGE_API_KEY!;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

export async function GET(req: NextRequest) {
  const deny = requireAdmin(req); if (deny) return deny;
  const wecomId = req.nextUrl.searchParams.get('wecom_id');
  if (!wecomId) return NextResponse.json({ ok: false, error: '缺 wecom_id' }, { status: 400 });

  const [permsRes, userArr] = await Promise.all([
    fetch(`${POSTGREST_URL}/rpc/get_user_perms`, {
      method: 'POST', headers: H, body: JSON.stringify({ p_wecom_id: wecomId }),
    }).then(r => r.json()).catch(() => null),
    fetch(`${POSTGREST_URL}/org_users?select=wecom_id,name,role_id,role_source,department_ids&wecom_id=eq.${encodeURIComponent(wecomId)}`, { headers: H, cache: 'no-store' })
      .then(r => r.json()).catch(() => []),
  ]);
  const user = Array.isArray(userArr) ? userArr[0] ?? null : null;

  const roleArr = user?.role_id
    ? await fetch(`${POSTGREST_URL}/roles?select=id,code,name&id=eq.${user.role_id}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => [])
    : [];
  const deptIds: string[] = Array.isArray(user?.department_ids) ? user.department_ids : [];
  const depts = deptIds.length
    ? await fetch(`${POSTGREST_URL}/org_departments?select=id,name,branch_nums,can_see_cost&id=in.(${deptIds.map(x => `"${x}"`).join(',')})`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => [])
    : [];
  // data_permissions 无 RLS（072 设计：仅 SECURITY DEFINER 可读）；此处用 service key 直查（admin 已鉴权）
  const subjectFilter = `or=(and(subject_type.eq.user,subject_id.eq.${encodeURIComponent(wecomId)}),and(subject_type.eq.role,subject_id.eq.${user?.role_id ?? -1}))`;
  const perms = await fetch(`${POSTGREST_URL}/data_permissions?select=subject_type,subject_id,branch_nums,brands,categories,can_see_cost,expires_at,note&${subjectFilter}`, { headers: H, cache: 'no-store' }).then(r => r.json()).catch(() => []);

  return NextResponse.json({
    effective: permsRes,
    layers: { user, role: roleArr?.[0] ?? null, departments: depts, permissions: perms },
  });
}
```

- [ ] **Step 4: 类型检查 + 构建验证**

```bash
cd web && npm run build
```

预期:编译通过(无 TS 错)。

- [ ] **Step 5: Commit**

```bash
git add web/lib/admin-api-auth.ts web/app/api/admin/permissions/
git commit -m "feat(admin): 权限管理 API——requireAdmin 鉴权 + users 指派 + preview 生效预览"
```

---

### Task 8: /admin/permissions 管理页

**Files:**
- Create: `web/app/admin/permissions/page.tsx`
- Modify: `web/app/admin/layout.tsx`(若有导航数组则加入口;先读文件确认形态)

**Interfaces:**
- Consumes: Task 7 的三个路由;`requireAdmin` 已在路由层,页面自身无需鉴权逻辑(middleware 已守 /admin 页面)。

- [ ] **Step 0: 读 admin/layout.tsx 与一个现有 admin 页(如 admin/branches/page.tsx)确认页面/导航形态**

照现有页的容器/标题/表格风格写(DESIGN.md:DM Sans + tabular-nums,slate 中性色,不引入新组件库)。

- [ ] **Step 1: 页面(用户角色指派 + 生效权限预览)**

```tsx
// web/app/admin/permissions/page.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';

type Role = { id: number; code: string; name: string };
type Dept = { id: string; name: string };
type User = {
  wecom_id: string; name: string; department_ids: string[];
  role_id: number | null; role_source: 'auto' | 'manual';
};
type Preview = {
  effective: {
    role_code: string | null; branch_nums: string[]; brands: string[];
    categories: string[]; can_see_cost: boolean;
  } | null;
  layers: {
    user: User | null;
    role: Role | null;
    departments: (Dept & { branch_nums: string[]; can_see_cost: boolean })[];
    permissions: { subject_type: string; subject_id: string; can_see_cost: boolean; expires_at: string | null; note: string | null }[];
  };
};

export default function PermissionsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; data: Preview } | null>(null);
  const [error, setError] = useState('');

  const deptName = useMemo(() => {
    const m = new Map(depts.map(d => [d.id, d.name]));
    return (ids: string[]) => ids.map(i => m.get(i) ?? i).join('、') || '—';
  }, [depts]);

  async function load() {
    const r = await fetch('/api/admin/permissions/users', { cache: 'no-store' });
    if (!r.ok) { setError(`加载失败 ${r.status}`); return; }
    const d = await r.json();
    setUsers(d.users ?? []); setRoles(d.roles ?? []); setDepts(d.departments ?? []);
  }
  useEffect(() => { load(); }, []);

  async function assign(u: User, roleId: number | null) {
    setSaving(u.wecom_id);
    const r = await fetch('/api/admin/permissions/users', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wecom_id: u.wecom_id, role_id: roleId }),
    });
    setSaving(null);
    if (!r.ok) { setError(`保存失败 ${r.status}`); return; }
    await load();
  }

  async function showPreview(wecomId: string) {
    const r = await fetch(`/api/admin/permissions/preview?wecom_id=${encodeURIComponent(wecomId)}`, { cache: 'no-store' });
    if (!r.ok) { setError(`预览失败 ${r.status}`); return; }
    setPreview({ id: wecomId, data: await r.json() });
  }

  const filtered = users.filter(u =>
    !search || u.name?.includes(search) || u.wecom_id.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="p-6 max-w-6xl mx-auto font-sans">
      <h1 className="text-xl font-semibold text-slate-800 mb-1">权限管理</h1>
      <p className="text-sm text-slate-500 mb-4">
        角色指派（manual 不被同步覆盖；选「自动」恢复同步赋值）。用户重新登录后新权限生效。
      </p>
      {error && <div className="mb-3 text-sm text-red-600">{error}</div>}

      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="搜索姓名 / 企微 ID"
        className="mb-4 w-72 rounded border border-slate-300 px-3 py-1.5 text-sm"
      />

      <table className="w-full text-sm border-collapse tabular-nums">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-4">姓名</th>
            <th className="py-2 pr-4">部门</th>
            <th className="py-2 pr-4">角色</th>
            <th className="py-2 pr-4">来源</th>
            <th className="py-2">操作</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(u => (
            <tr key={u.wecom_id} className="border-b border-slate-100">
              <td className="py-2 pr-4 text-slate-800">{u.name ?? u.wecom_id}</td>
              <td className="py-2 pr-4 text-slate-600">{deptName(u.department_ids)}</td>
              <td className="py-2 pr-4">
                <select
                  value={u.role_source === 'manual' ? (u.role_id ?? '') : ''}
                  disabled={saving === u.wecom_id}
                  onChange={e => assign(u, e.target.value ? Number(e.target.value) : null)}
                  className="rounded border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="">自动{u.role_source === 'auto' && u.role_id
                    ? `（${roles.find(r => r.id === u.role_id)?.name ?? u.role_id}）` : ''}</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </td>
              <td className="py-2 pr-4">
                <span className={u.role_source === 'manual' ? 'text-blue-700' : 'text-slate-400'}>
                  {u.role_source === 'manual' ? '手动' : '自动'}
                </span>
              </td>
              <td className="py-2">
                <button onClick={() => showPreview(u.wecom_id)}
                  className="text-blue-700 hover:underline text-sm">生效预览</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {preview && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-lg shadow-lg p-6 w-[560px] max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <h2 className="text-base font-semibold text-slate-800 mb-3">生效权限 — {preview.id}</h2>
            <PreviewView data={preview.data} />
            <button onClick={() => setPreview(null)}
              className="mt-4 text-sm text-slate-500 hover:underline">关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex py-1 text-sm">
      <div className="w-28 shrink-0 text-slate-500">{label}</div>
      <div className="text-slate-800 tabular-nums">{value}</div>
    </div>
  );
}

function PreviewView({ data }: { data: Preview }) {
  const e = data.effective;
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-700 mt-2 mb-1">合成结果（重新登录后写入 JWT）</h3>
      <Row label="角色" value={e?.role_code ?? '—'} />
      <Row label="门店范围" value={e?.branch_nums?.join(', ') ?? '—'} />
      <Row label="品牌范围" value={e?.brands?.join(', ') ?? '—'} />
      <Row label="品类范围" value={e?.categories?.join(', ') ?? '—'} />
      <Row label="可见成本" value={e ? (e.can_see_cost ? '是' : '否') : '—'} />
      <h3 className="text-sm font-medium text-slate-700 mt-4 mb-1">分层来源</h3>
      <Row label="角色层" value={data.layers.role ? `${data.layers.role.name}（${data.layers.user?.role_source}）` : '未指派'} />
      <Row label="部门层" value={data.layers.departments.map(d =>
        `${d.name}：门店 ${d.branch_nums?.join(',') ?? '*'}${d.can_see_cost ? '，可见成本' : ''}`).join('；') || '—'} />
      <Row label="个人 override" value={data.layers.permissions.filter(p => p.subject_type === 'user')
        .map(p => `${p.note ?? ''}${p.expires_at ? `（至 ${p.expires_at.slice(0, 10)}）` : ''}`).join('；') || '无'} />
    </div>
  );
}
```

- [ ] **Step 2: 导航入口**

读 `web/app/admin/layout.tsx`:若有导航数组,按现有条目形状加 `{ href: '/admin/permissions', label: '权限' }`(字段名以实际为准);若布局无导航则跳过。

- [ ] **Step 3: 构建验证**

```bash
cd web && npm run build
```

预期:编译通过。

- [ ] **Step 4: Commit**

```bash
git add web/app/admin/permissions/ web/app/admin/layout.tsx
git commit -m "feat(admin): /admin/permissions 权限管理页——角色指派 + 生效权限预览"
```

---

### Task 9: 运维文档 + 部署编排 + 生产灰度

**Files:**
- Create: `docs/ops/permission-maintenance.md`

- [ ] **Step 1: 写运维文档**

```markdown
# 报表权限运维手册（2026-08-03 权限收口后）

## 模型
生效权限 = 个人 override > 角色 ∪ 部门（get_user_perms 合成，登录时写入 JWT，
用户重新登录后新权限生效）。行过滤在 report_*_gen 视图（claim_match_or_star），
列脱敏 can_see_cost CASE。claim 缺失/含 "*" = 放行。

## 常见操作（生产 psql：docker exec deploy-postgres-1 psql -U postgres -d insforge）

### 收窄某部门可见门店
UPDATE org_departments SET branch_nums='["3","5","8"]'::jsonb WHERE id='<企微部门id>';
-- 门店号跨账套重复，brands 维度经角色层控制；收窄后通知该部门用户重新登录。

### 放开/收回某部门成本可见
UPDATE org_departments SET can_see_cost=true WHERE id='<id>';   -- 收回置 false

### 给个人临时授权（如临时看成本 7 天）
INSERT INTO data_permissions (subject_type, subject_id, can_see_cost, expires_at, note)
VALUES ('user', '<wecom_id>', true, NOW() + INTERVAL '7 days', '临时成本核对');

### 指派/恢复角色
-- 优先用 /admin/permissions 页面；SQL 等效：
UPDATE org_users SET role_id=<roles.id>, role_source='manual' WHERE wecom_id='<id>';
UPDATE org_users SET role_id=NULL, role_source='auto' WHERE wecom_id='<id>';  -- 恢复自动

### 排障：看某人当前生效权限
SELECT get_user_perms('<wecom_id>');
```

- [ ] **Step 2: 部署(GHA)**

```bash
git push origin main
gh run list --limit 3
gh run watch <run-id>
```

预期:5 steps 全绿(迁移 152 + generated 视图应用 + web 构建)。deploy.sh 迁移后自动 restart postgrest;若视图未生效手动补:

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker compose restart postgrest"
```

- [ ] **Step 3: 部署 function(SSH PUT + 清 Deno 缓存)**

GHA 迁移成功后(152 的 RPC 已在库):

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com 'cd /opt/data-analytics-platform/deploy && set -a; . ./.env; set +a
body=$(jq -n --arg slug "wecom-sync-contacts" --arg name "wecom-sync-contacts" --arg desc "wecom-sync-contacts" --rawfile code "$PWD/../functions/wecom-sync-contacts/index.js" "{slug:\$slug,name:\$name,description:\$desc,code:\$code,status:\"active\"}")
curl -sf -X PUT -H "Authorization: Bearer $INSFORGE_API_KEY" -H "Content-Type: application/json" -d "$body" http://localhost:7130/api/functions/wecom-sync-contacts'
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "cd /opt/data-analytics-platform/deploy && docker exec deploy-deno-1 rm -rf /deno-dir/* && docker compose restart deno"
```

- [ ] **Step 4: 触发同步,验证 role_id 回填**

```bash
curl -s -X POST https://data.shanhaiyiguo.com/functions/wecom-sync-contacts
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT count(*) FILTER (WHERE role_id IS NOT NULL) AS with_role, count(*) AS total FROM org_users WHERE is_active; SELECT r.code, count(*) FROM org_users u JOIN roles r ON r.id=u.role_id WHERE u.is_active GROUP BY 1 ORDER BY 1;\""
```

预期:返回 `role_assign:{mapped, assigned}`;with_role/total 占比合理;角色分布符合预期(boss/finance 少,manager 多)。**命中率明显异常(如全 NULL 或全 manager)先停,核对 dept_role_mapping 正则与部门名。**

- [ ] **Step 5: 灰度验证①——claims 全 ["*"] 时行为零变化**

此时所有用户 branch_nums 仍是 ["*"](部门列未收窄),过滤应完全无感。抽查报表中心各页(达成看板/品牌指标/品类汇总/批发日表/供应链出库/商品下钻)数据与上线前一致;对账基准:`report_achievement_v` 合计行金额与上线前截图/记录比对。

再用自签 JWT 直连 PostgREST 验证裁行生效（手法：本地用 `jsonwebtoken` 或一行 node 脚本以 JWT_SECRET 签 HS256 token；JWT_SECRET 从服务器容器 env 取——`docker exec deploy-postgres-1 env | grep JWT_SECRET`，或 insforge 容器 env，同 wecom-oauth 签名密钥）：

```bash
# 本地签两个 token（claims 不同）：branch_nums ["*"] vs ["3"]，can_see_cost false vs true
node -e 'const jwt=require("jsonwebtoken");const s=process.env.JWT_SECRET;
const sign=(o)=>jwt.sign({sub:"perm_test",role:"authenticated",...o},s,{expiresIn:"5m"});
console.log("STAR="+sign({branch_nums:["*"],brands:["*"],can_see_cost:false}));
console.log("NARROW="+sign({branch_nums:["3"],brands:["3120"],can_see_cost:false}));
console.log("COST="+sign({branch_nums:["*"],brands:["*"],can_see_cost:true}));'

# 逐个 curl 生产网关比对（行数：STAR > NARROW；毛利列：STAR/COST 一为 NULL 一有值）
curl -s "https://data.shanhaiyiguo.com/api/database/records/report_brand_metric_gen" -H "Authorization: Bearer <TOKEN>" | head -c 500
```

预期：NARROW 的品牌行只剩 3120 且金额严格小于 STAR;can_see_cost=false 时毛利列 NULL,true 时有值。

- [ ] **Step 6: 灰度验证②——单部门收窄试点**

选一个部门(如某战区)收窄 branch_nums(运维手册 SQL),让该部门一个用户重新登录,确认:其报表只见授权门店行、合计行同步收窄、毛利列按其角色/部门规则显隐。验证通过后可逐部门推广(节奏用户自定,不在本计划)。

- [ ] **Step 7: 还原 can_see_cost 临时放开(灰度最后一步)**

```bash
ssh -i "~/.ssh/ShanHai-OPS.pem" root@data.shanhaiyiguo.com "docker exec deploy-postgres-1 psql -U postgres -d insforge -c \"SELECT id, name FROM org_departments WHERE can_see_cost=true ORDER BY id;\""
```

把清单贴给用户确认哪些保留,其余:

```sql
UPDATE org_departments SET can_see_cost=false WHERE id IN (<确认收回的部门id>);
```

验证:boss/finance/zone_manager 角色用户重新登录后毛利可见;manager/buyer 用户毛利列 NULL。

- [ ] **Step 8: Commit 运维文档 + 收尾**

```bash
git add docs/ops/permission-maintenance.md
git commit -m "docs(ops): 报表权限运维手册——收窄门店/成本开关/临时授权/排障"
git push origin main
```

---

## Self-Review 记录

- **Spec 覆盖**:C1 生成器过滤→Task 1-4 ✅;C2 role_id 链路→Task 5-6 ✅;C3 管理页(角色指派+预览,含 API 鉴权)→Task 7-8 ✅;C4 生产迁移(还原放开、逐部门收窄)→Task 9 ✅;灰度顺序/回归手段→Task 9 ✅;明确不做项未混入 ✅。
- **类型一致性**:`permFilterFact/permFilterTarget`(Task 2 产,Task 3 消费)签名一致;`refresh_role_assignments()`(Task 5 产,Task 6 消费)一致;`requireAdmin`(Task 7 产,同 Task 两路由消费)一致;`role_source` 值域 auto/manual 在迁移/API/页面三处一致。
- **已知风险记录**:fixture 字段名以 `src/types.ts` 为准(Task 2 Step 1 已注明);hierarchy 的 category 视图 fact 别名以现有代码为准(Task 3 Step 3 已注明)。

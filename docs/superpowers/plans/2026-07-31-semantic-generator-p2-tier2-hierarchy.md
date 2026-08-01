# P2: Tier2 窗口派生 + 维度层级生成器 + 下钻表迁移

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** 生成器增加 Tier2 窗口派生能力 + 维度层级抽象，迁移 `report_region_breakdown_v`（三级下钻）到生成器产物，为后续多个下钻场景铺路。

**Architecture:** 方案 B（全生成器通用化）。ViewConfig 增加 `hierarchy`（多级 grain + 各级 target_breakdown + rollup_from）和 Tier2 窗口指标解析。生成器产出多级 UNION ALL 视图。新下钻 = 加配置，不写 SQL。

**Tech Stack:** TypeScript + Node.js（services/semantic-generator）

## Global Constraints

- 视图 `DROP VIEW IF EXISTS + CREATE VIEW`，禁 `CREATE OR REPLACE`
- 加视图后 `docker compose restart postgrest`（GHA deploy.sh 已保证）
- 比率指标 `SUM(profit)/SUM(amount)` 重算，禁直接 SUM（additive=false）
- 门店键 = `(system_book_code, branch_num)` 复合，禁用 `branch_num` 单独 join/PK
- 配送口径 = 调拨(3120) + 品品甜批发(64188 收货方)，与品牌表一致
- 下钻表三级层级：war_zone(first_level_region) → region_l2(second_level_region) → store(sbc, branch_num)

## 关键事实（已核实）

- dim_branch 列：system_book_code, branch_num, branch_name, first_level_region, second_level_region, is_active
- target_metric_values 三级分解齐备：store(243) / region_l2(14) / war_zone(4)，sale 三级和均=22,790,000 自洽
- registry（迁移119）已有 Tier2 指标定义：
  - daily_sale: `sale_amount FILTER(biz_date=latest_day)`，depends_on [sale_amount]
  - daily_delivery: `delivery_amount FILTER(biz_date=latest_day)`
  - remaining_daily_sale: `(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)`
  - remaining_daily_delivery: `(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)`
  - sale_rate: `sale_amount / sale_target`；delivery_rate: `delivery_amount / delivery_target`
- 现有视图 120（`report_region_breakdown_v`）输出 18 列，前端 RegionBreakdownRow 一一对应

---

## 任务概览

| 序 | 任务 | 说明 |
|----|------|------|
| T1 | Tier2：tgt 窗口列 | tgt CTE 增 total_days/days_elapsed/latest_day |
| T2 | Tier2：当日指标（FILTER latest_day） | base CTE 产 daily 列 |
| T3 | Tier2：剩余日均（窗口公式派生） | remaining_daily 解析 |
| T4 | 层级：HierarchyLevel 类型 + 叶级生成 | 类型 + 叶级 actual/target/daily |
| T5 | 层级：父级 rollup + 各级 target join | SUM 叶级 actual + 该级 target |
| T6 | 层级：各级 dim_cols + UNION ALL | 多级输出列映射 + 合并 |
| T7 | 下钻视图配置 + 生成 + EXPLAIN | report_region_breakdown_gen |
| T8 | L3b 双轨 diff=0 vs 120 | 各列逐字一致 |
| T9 | 前端切换 + 下线旧视图 | 迁移收口 |

---

### Task 1: Tier2 — tgt 窗口列

**Files:**
- Modify: `services/semantic-generator/src/generators/tier1.ts`（tgt CTE）
- Test: `services/semantic-generator/__tests__/tier2.test.ts`（新建）

**Interfaces:**
- Produces: tgt CTE 含 `target_id, start_date, end_date, total_days, days_elapsed, latest_day`

- [ ] **Step 1: 写失败测试**

```typescript
// __tests__/tier2.test.ts
import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { Metric, MetricSource, ViewConfig } from '../src/types';

const baseMetric = (code: string, col: string): Metric => ({
  metric_code: code, name: code, measure_type: 'base', fact_table: 'report_daily_sales',
  value_column: col, agg: 'SUM', formula: null, depends_on: [], additive: true,
  cost_sensitive: false, unit: '元', data_ready: true, enabled: true,
  description: null, business_formula: null,
});

describe('Tier2 window context', () => {
  it('tgt CTE 含 total_days/days_elapsed/latest_day 当 target_window=true', () => {
    const config: ViewConfig = {
      view_name: 'v_test', metrics: ['sale_amount'], dim_code: 'brand',
      levels: [], target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: false },
    };
    const sql = generateTier1View(config, [baseMetric('sale_amount', 'total_sale')],
      [{ metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null }]);
    expect(sql).toContain('total_days');
    expect(sql).toContain('days_elapsed');
    expect(sql).toContain('latest_day');
    expect(sql).toContain('GREATEST(LEAST(current_date');
  });
});
```

- [ ] **Step 2: 运行验证失败**

```bash
cd services/semantic-generator && npm test -- tier2
# 预期 FAIL: 不含 total_days
```

- [ ] **Step 3: 改 tgt CTE**

把 tier1.ts 里 tgt CTE 改为（照 120）：
```typescript
cteList.push(`tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
)`);
```

- [ ] **Step 4: 验证通过 + 不破坏现有 15 测试**

```bash
npm test
# 预期: tier2 1 test + 原 15 tests 全过
```

- [ ] **Step 5: 提交**

```bash
git add services/semantic-generator/src/generators/tier1.ts services/semantic-generator/__tests__/tier2.test.ts
git commit -m "feat(generator): Tier2 tgt 窗口列（total_days/days_elapsed/latest_day）"
```

---

### Task 2: Tier2 — 当日指标（FILTER latest_day）

**Files:**
- Modify: `services/semantic-generator/src/generators/tier1.ts`
- Test: `__tests__/tier2.test.ts`

**Interfaces:**
- 识别 formula 含 `FILTER(biz_date=latest_day)` → base CTE 加 `SUM(col) FILTER (WHERE s.biz_date = tgt.latest_day) AS <code>`

- [ ] **Step 1: 写失败测试**

```typescript
it('daily 指标 → base CTE 加 FILTER(latest_day) 聚合列', () => {
  const dailyMetric: Metric = {
    ...baseMetric('daily_sale', 'total_sale'),
    measure_type: 'derived', fact_table: null, value_column: null, agg: null,
    formula: 'sale_amount FILTER(biz_date=latest_day)', depends_on: ['sale_amount'],
    additive: true,
  };
  const config: ViewConfig = {
    view_name: 'v_test', metrics: ['sale_amount', 'daily_sale'], dim_code: 'brand',
    levels: [], target_metric_codes: [],
    scope: { target_window: true, assessed_war_zone: false },
  };
  const sql = generateTier1View(config,
    [baseMetric('sale_amount', 'total_sale'), dailyMetric],
    [{ metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null }]);
  expect(sql).toContain('FILTER (WHERE s.biz_date = tgt.latest_day)');
  expect(sql).toContain('AS daily_sale');
});
```

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 实现 daily 识别**

在 collectLeaves 后、actual CTE 构建中，检测 selected derived 指标里 formula 含 `FILTER(biz_date=latest_day)` 的（如 daily_sale）。对其 depends_on[0] 的 base 指标，在该 base 所属 actual CTE 额外加一列：
```typescript
// daily_metrics: Map<baseMetricCode, dailyMetricCode>
for (const [baseCode, dailyCode] of daily_metrics) {
  const src = sources.find(s => s.metric_code === baseCode)!;
  cols.push(`SUM(s.${src.source_column}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
}
```
并在 cteOf 注册 dailyCode → 该 CTE。SELECT 输出时 daily 指标按 base 引用（已是聚合值，直接 `cteN.daily_sale`）。

- [ ] **Step 4: 验证通过 + 全测试**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(generator): Tier2 当日指标 FILTER(latest_day)"
```

---

### Task 3: Tier2 — 剩余日均（窗口公式派生）

**Files:**
- Modify: `services/semantic-generator/src/generators/tier1.ts`
- Test: `__tests__/tier2.test.ts`

**Interfaces:**
- formula 含 `total_days`/`days_elapsed` → 派生指标引用 tgt 窗口列；token 替换 base metric_code → cte 引用

- [ ] **Step 1: 写失败测试**

```typescript
it('remaining_daily 指标 → 引用 tgt.total_days/days_elapsed', () => {
  const remMetric: Metric = {
    ...baseMetric('remaining_daily_sale', ''),
    measure_type: 'derived', fact_table: null, value_column: null, agg: null,
    formula: '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)',
    depends_on: ['sale_target', 'sale_amount'], additive: true,
  };
  // config 含 sale_amount(base actual) + sale_target(base target_metric_values) + remaining_daily_sale
  // scope target_window=true
  const sql = generateTier1View(config, metrics, sources);
  expect(sql).toContain('tgt.total_days');
  expect(sql).toContain('tgt.days_elapsed');
  expect(sql).toContain('remaining_daily_sale');
});
```

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 实现 remaining 解析**

metricRef/expandAdditive 中：公式 token 替换时，若 token 是已知 base/derived metric_code → cte 引用（已有）；若 token ∈ {total_days, days_elapsed, latest_day, current_date} → 保留为 `tgt.<token>`（窗口列，需 target_window）。sale_target 等 target_metric_values base 走 target CTE（已有）。

- [ ] **Step 4: 验证通过 + 全测试**

- [ ] **Step 5: 提交**

```bash
git commit -m "feat(generator): Tier2 剩余日均（窗口列引用）"
```

---

### Task 4: 层级 — HierarchyLevel 类型 + 叶级生成

**Files:**
- Modify: `services/semantic-generator/src/types.ts`（加 HierarchyLevel）
- Create: `services/semantic-generator/src/generators/hierarchy.ts`
- Test: `__tests__/hierarchy.test.ts`

**Interfaces:**
```typescript
export interface HierarchyLevel {
  level: string;                  // 'store' | 'sub_region' | 'region'
  grain: string[];                // 该级分组键（如 ['system_book_code','branch_num']）
  target_breakdown: string;       // 'store' | 'region_l2' | 'war_zone'
  rollup_from?: string;           // 父级 actual 从哪级 rollup（通常 'store'）
  is_leaf: boolean;
  columns: { out: string; expr: string }[]; // 输出维度列（如 {out:'region_code', expr:'war_zone'}）
}
// ViewConfig 加: hierarchy?: HierarchyLevel[]
```

- [ ] **Step 1: 写失败测试** — hierarchy 配置存在时，生成叶级 actual CTE（按叶级 grain 聚合，含 daily FILTER）

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 实现 hierarchy.ts**

`generateHierarchyView(config, metrics, sources)`：
1. tgt CTE（含窗口列）
2. 叶级 actual CTE：按叶级 grain 聚合 base + daily FILTER，scope 日期+assessed
3. 叶级 target CTE：target_metric_values 按 target_breakdown=叶级，按叶级 grain
4. 返回 { cteList, leafActualName, leafGrain }

- [ ] **Step 4: 验证通过**

- [ ] **Step 5: 提交**

---

### Task 5: 层级 — 父级 rollup + 各级 target join

**Files:**
- Modify: `src/generators/hierarchy.ts`
- Test: `__tests__/hierarchy.test.ts`

- [ ] **Step 1: 写测试** — 父级（如 sub_region）actual = `SELECT grain, SUM(sale_actual)... FROM leaf_actual GROUP BY grain`；父级 target CTE = target_metric_values 按 region_l2 分解

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 实现**

对每个父级 level：
```typescript
// 父级 actual rollup CTE
cteList.push(`${level.level}_act AS (
  SELECT ${level.grain.join(', ')},
    SUM(sale_actual) AS sale_actual, SUM(daily_sale) AS daily_sale, ...
  FROM ${leafActualName}
  GROUP BY ${level.grain.join(', ')}
)`);
// 父级 target CTE（breakdown_level = level.target_breakdown）
```

- [ ] **Step 4: 验证通过**

- [ ] **Step 5: 提交**

---

### Task 6: 层级 — 各级 dim_cols + UNION ALL

**Files:**
- Modify: `src/generators/hierarchy.ts`
- Test: `__tests__/hierarchy.test.ts`

- [ ] **Step 1: 写测试** — 每级输出其 columns 映射 + level/parent_code；三级 UNION ALL；rate/remaining 每级计算

- [ ] **Step 2: 验证失败**

- [ ] **Step 3: 实现**

对每级生成 SELECT（引用该级 actual CTE + target CTE + tgt 窗口），输出：
- level, parent_code（按级固定）
- 该级 columns（如 store: branch_num/branch_name/region_code/sub_region_code；region: 仅 region_code，其余 NULL）
- 各指标（actual/target 直接引用；rate/remaining/daily 按公式展开）
UNION ALL 所有级。

- [ ] **Step 4: 验证通过 + 全测试**

- [ ] **Step 5: 提交**

---

### Task 7: 下钻视图配置 + 生成 + EXPLAIN

**Files:**
- Modify: `src/view-configs.ts`（加 regionBreakdownView）
- Modify: `src/index.ts`（CLI 加该 config）
- Create: `database/generated/report_region_breakdown_gen.sql`

- [ ] **Step 1: 写 view config**

```typescript
export const regionBreakdownView: ViewConfig = {
  view_name: 'report_region_breakdown_gen',
  metrics: ['sale_amount','sale_target','sale_rate','daily_sale',
            'delivery_amount','delivery_target','delivery_rate','daily_delivery',
            'remaining_daily_sale','remaining_daily_delivery'],
  dim_code: 'branch',
  levels: ['store','sub_region','region'],
  target_metric_codes: ['sale_target','delivery_target'],
  scope: { target_window: true, assessed_war_zone: true },
  aliases: { sale_amount:'sale_actual', delivery_amount:'delivery_actual',
             remaining_daily_sale:'remaining_daily_sale_target',
             remaining_daily_delivery:'remaining_daily_delivery_target' },
  hierarchy: [
    { level:'region', grain:['war_zone'], target_breakdown:'war_zone', rollup_from:'store', is_leaf:false,
      columns:[{out:'region_code',expr:'war_zone'},{out:'region_name',expr:'war_zone'}] },
    { level:'sub_region', grain:['war_zone','region_l2'], target_breakdown:'region_l2', rollup_from:'store', is_leaf:false,
      columns:[{out:'region_code',expr:'war_zone'},{out:'region_name',expr:'war_zone'},
               {out:'sub_region_code',expr:'region_l2'},{out:'sub_region_name',expr:'region_l2'}] },
    { level:'store', grain:['system_book_code','branch_num'], target_breakdown:'store', is_leaf:true,
      columns:[{out:'region_code',expr:'war_zone'},{out:'region_name',expr:'war_zone'},
               {out:'sub_region_code',expr:'region_l2'},{out:'sub_region_name',expr:'region_l2'},
               {out:'branch_num',expr:'branch_num'},{out:'branch_name',expr:'branch_name'}] },
  ],
};
```

- [ ] **Step 2: 生成**

```bash
npm run gen-views
```

- [ ] **Step 3: EXPLAIN 校验**（dev DB 空数据但结构对）

```bash
# 失败则修生成器，不产文件
```

- [ ] **Step 4: 提交**

---

### Task 8: L3b 双轨 diff=0 vs 120

**Files:**
- Run: 生成器部署 prod + 对比

- [ ] **Step 1: 部署生成视图到 prod**

```bash
ssh ... "docker exec -i deploy-postgres-1 psql ..." < database/generated/report_region_breakdown_gen.sql
```

- [ ] **Step 2: 各列 SUM diff**

```sql
-- 三级各列：sale_target/sale_actual/sale_rate/delivery_*/daily_*/remaining_*
-- report_region_breakdown_gen vs report_region_breakdown_v（120）GROUP BY level
```

- [ ] **Step 3: diff≠0 则排查**（公式/口径/rollup 差异），diff=0 才进 T9

---

### Task 9: 前端切换 + 下线旧视图

**Files:**
- Modify: `web/lib/report-center/region-breakdown.ts`
- Create: `database/migrations/127_drop_old_region_breakdown_v.sql`

- [ ] **Step 1: 前端切 `_gen`**（确认列名/列序与 RegionBreakdownRow 一致）
- [ ] **Step 2: GHA 部署**（push）
- [ ] **Step 3: 验证生成视图经 migrate.sh 部署 + anon 可读**
- [ ] **Step 4: 下线旧视图**（迁移 127 DROP，确认无引用后 push）

---

## 验收标准

| 标准 | 验证 |
|------|------|
| Tier2 窗口指标生成正确 | daily FILTER + remaining 引用 tgt 窗口列，单测过 |
| 层级抽象可复用 | 下钻视图纯配置生成，无手写 SQL |
| 双轨 diff=0 | 三级各列 SUM 一致 vs 120 |
| 前端三级展开正常 | RegionDrillTable 数据正确 |
| 后续下钻零 SQL | 新下钻只加 hierarchy 配置 |

## 风险

| 风险 | 缓解 |
|------|------|
| 层级 rollup 口径与 120 不一致 | T8 逐级 diff，diff≠0 不切 |
| Tier2 公式解析边界（嵌套/多算子） | 单测覆盖 daily/remaining 两类 |
| 父级 dim_cols NULL 映射错 | T6 测试各级列输出 |

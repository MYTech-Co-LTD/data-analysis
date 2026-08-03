import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { generateHierarchyView } from '../src/generators/hierarchy';
import { Metric, MetricSource, ViewConfig, HierarchyLevel } from '../src/types';

const BRANDS_PRED = `claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb`;
const BRANCH_PRED = `claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb`;

// 照 tier1.test.ts fixture 字段名（formula_ast/note/levels/target_metric_codes 补齐 types.ts 必填字段）
const mockMetrics: Metric[] = [
  {
    metric_code: 'sale_amount',
    name: '销售金额',
    measure_type: 'base',
    fact_table: 'report_daily_sales',
    value_column: 'total_sale',
    agg: 'SUM',
    formula_ast: null,
    depends_on: [],
    additive: true,
    cost_sensitive: false,
    unit: '元',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
  {
    metric_code: 'sale_profit',
    name: '销售毛利',
    measure_type: 'base',
    fact_table: 'report_daily_sales',
    value_column: 'total_profit',
    agg: 'SUM',
    formula_ast: null,
    depends_on: [],
    additive: true,
    cost_sensitive: true,
    unit: '元',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
  {
    metric_code: 'sale_target',
    name: '销售目标',
    measure_type: 'base',
    fact_table: 'target_metric_values',
    value_column: 'target_value',
    agg: 'SUM',
    formula_ast: null,
    depends_on: [],
    additive: true,
    cost_sensitive: false,
    unit: '元',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
];

const mockSources: MetricSource[] = [
  { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null },
  { metric_code: 'sale_profit', source_table: 'report_daily_sales', source_column: 'total_profit', source_filter: null, note: null },
  { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
];

const config: ViewConfig = {
  view_name: 'report_perm_test_gen',
  metrics: ['sale_amount', 'sale_profit', 'sale_target'],
  dim_code: 'brand',
  levels: ['brand'],
  target_metric_codes: [],
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

// ── hierarchy 用例：叶级 actual/target CTE + dim 行过滤 + category 视图 ──
// fixture 复用 hierarchy.test.ts 的 threeLevelHierarchy 模式（store + region 两级）
const hierLevels: HierarchyLevel[] = [
  {
    level: 'store',
    grain: ['system_book_code', 'branch_num'],
    target_breakdown: 'store',
    is_leaf: true,
    columns: [
      { out: 'branch_name', expr: 'branch_name' },
      { out: 'war_zone', expr: 'first_level_region' },
    ],
  },
  {
    level: 'region',
    grain: ['war_zone'],
    target_breakdown: 'war_zone',
    is_leaf: false,
    rollup_from: 'store',
    columns: [],
  },
];

const hierConfig: ViewConfig = {
  view_name: 'v_perm_hier_test',
  metrics: ['sale_amount', 'sale_target'],
  dim_code: 'branch',
  levels: ['store', 'region'],
  target_metric_codes: ['sale_target'],
  scope: { target_window: true, assessed_war_zone: false },
  hierarchy: hierLevels,
};

// category 视图配置（照 hierarchy.test.ts category 用例模式）
function generateCategorySql(): string {
  const catConfig: ViewConfig = {
    view_name: 'report_cat_test_gen',
    dim_code: 'category',
    metrics: ['outbound_amount', 'outbound_profit'],
    levels: [],
    target_metric_codes: [],
    scope: { target_level: 'total', target_status: ['active'] },
    total_row: true,
    target_breakdown: 'category',
    categories: ['水果', '标品'],
  };
  const catSources: MetricSource[] = [
    { metric_code: 'delivery_amount', source_table: 'report_daily_delivery', source_column: 'out_money', source_filter: null, note: null },
    { metric_code: 'wholesale_amount', source_table: 'report_daily_wholesale', source_column: 'wholesale_money', source_filter: null, note: null },
    { metric_code: 'outbound_amount_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='outbound_amt'", note: null },
    { metric_code: 'outbound_profit_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='outbound_profit'", note: null },
  ];
  // generateCategoryView 不使用 metrics 参数（只读 config + sources），传空数组即可
  return generateHierarchyView(catConfig, [], catSources);
}

describe('权限收口：hierarchy 行级过滤注入', () => {
  it('叶级 actual CTE 含 brands + branch_nums 过滤', () => {
    const sql = generateHierarchyView(hierConfig, mockMetrics, mockSources);
    expect(sql).toContain(BRANDS_PRED);
    expect(sql).toContain(BRANCH_PRED);
  });

  it('叶级 target CTE 过滤带 ALL 放行', () => {
    const sql = generateHierarchyView(hierConfig, mockMetrics, mockSources);
    expect(sql).toContain(`t.branch_num = 'ALL'`);
  });

  it('dim 行（dim_branch）也被双维度过滤', () => {
    const sql = generateHierarchyView(hierConfig, mockMetrics, mockSources);
    // permFilterFact('db') -> db.system_book_code + db.branch_num::text
    expect(sql).toContain(`claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, db.system_book_code)`);
    expect(sql).toContain(`claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, db.branch_num::text)`);
  });

  it('category 视图 delivery/wholesale actuals 均含过滤', () => {
    const sql = generateCategorySql();
    const brandsCount = sql.split(BRANDS_PRED).length - 1;
    expect(brandsCount).toBeGreaterThanOrEqual(2); // delivery + wholesale 两个 actual CTE
  });
});

import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { Metric, MetricSource, ViewConfig } from '../src/types';

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

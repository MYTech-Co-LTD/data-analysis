import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { A } from '../src/ast';
import { Metric, MetricSource, ViewConfig } from '../src/types';

const baseMetric = (code: string, col: string): Metric => ({
  metric_code: code, name: code, measure_type: 'base', fact_table: 'report_daily_sales',
  value_column: col, agg: 'SUM', formula: null, formula_ast: null, depends_on: [], additive: true,
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

  it('daily 指标 → base CTE 加 FILTER(latest_day) 聚合列', () => {
    const dailyMetric: Metric = {
      ...baseMetric('daily_sale', 'total_sale'),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: 'sale_amount FILTER(biz_date=latest_day)', formula_ast: A.filter(A.ref('sale_amount'), 'biz_date', A.ref('latest_day')), depends_on: ['sale_amount'],
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
    // base CTE 多一列用 FILTER 聚合到 latest_day
    expect(sql).toContain('FILTER (WHERE s.biz_date = tgt.latest_day)');
    expect(sql).toContain('AS daily_sale');
    // SELECT 阶段 daily 指标像 base 一样直接引用 cte 列（不走 formula 展开）
    expect(sql).not.toContain('FILTER(biz_date=latest_day)');
    expect(sql).toMatch(/cte\d+\.daily_sale AS daily_sale/);
  });

  it('remaining_daily 指标 → 引用 tgt.total_days/days_elapsed，nullif 原样保留', () => {
    const saleTarget: Metric = {
      ...baseMetric('sale_target', 'target_value'),
      fact_table: null,
    };
    const remMetric: Metric = {
      ...baseMetric('remaining_daily_sale', ''),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)',
      formula_ast: A.op('/', A.op('-', A.ref('sale_target'), A.ref('sale_amount')), A.call('nullif', A.op('-', A.ref('total_days'), A.ref('days_elapsed')), A.lit(0))),
      depends_on: ['sale_target', 'sale_amount'], additive: true,
    };
    const config: ViewConfig = {
      view_name: 'v_test', metrics: ['sale_amount', 'sale_target', 'remaining_daily_sale'],
      dim_code: 'brand', levels: [], target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: false },
    };
    const sql = generateTier1View(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget, remMetric],
      [
        { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null },
        { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
      ]);
    // 窗口列必须以 tgt. 前缀出现（在 tgt CTE 里）
    expect(sql).toContain('tgt.total_days');
    expect(sql).toContain('tgt.days_elapsed');
    // nullif / 数字 0 原样保留
    expect(sql).toContain('nullif(');
    // 不该出现裸 total_days（即 nullif(total_days 这种）
    expect(sql).not.toContain('nullif(total_days');
    expect(sql).not.toContain('- total_days');
    // 输出列存在
    expect(sql).toContain('AS remaining_daily_sale');
  });

  it('remaining_daily 无 target_window 时窗口列原样保留（不前缀 tgt.）', () => {
    const saleTarget: Metric = {
      ...baseMetric('sale_target', 'target_value'),
      fact_table: null,
    };
    const remMetric: Metric = {
      ...baseMetric('remaining_daily_sale', ''),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)',
      formula_ast: A.op('/', A.op('-', A.ref('sale_target'), A.ref('sale_amount')), A.call('nullif', A.op('-', A.ref('total_days'), A.ref('days_elapsed')), A.lit(0))),
      depends_on: ['sale_target', 'sale_amount'], additive: true,
    };
    const config: ViewConfig = {
      view_name: 'v_test', metrics: ['sale_amount', 'sale_target', 'remaining_daily_sale'],
      dim_code: 'brand', levels: [], target_metric_codes: [],
      scope: { target_window: false, assessed_war_zone: false },
    };
    const sql = generateTier1View(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget, remMetric],
      [
        { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null },
        { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
      ]);
    // 无窗口不应注入 tgt. 前缀
    expect(sql).not.toContain('tgt.total_days');
    expect(sql).not.toContain('tgt.days_elapsed');
  });

  it('daily 指标在无 target_window 场景跳过 FILTER 列（无 latest_day）', () => {
    const dailyMetric: Metric = {
      ...baseMetric('daily_sale', 'total_sale'),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: 'sale_amount FILTER(biz_date=latest_day)', formula_ast: A.filter(A.ref('sale_amount'), 'biz_date', A.ref('latest_day')), depends_on: ['sale_amount'],
      additive: true,
    };
    const config: ViewConfig = {
      view_name: 'v_test', metrics: ['sale_amount', 'daily_sale'], dim_code: 'brand',
      levels: [], target_metric_codes: [],
      scope: { target_window: false, assessed_war_zone: false },
    };
    const sql = generateTier1View(config,
      [baseMetric('sale_amount', 'total_sale'), dailyMetric],
      [{ metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null }]);
    // 无窗口时不该产出 FILTER(latest_day) 列
    expect(sql).not.toContain('tgt.latest_day');
  });
});

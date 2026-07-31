import { describe, it, expect } from 'vitest';
import { generateHierarchyView } from '../src/generators/hierarchy';
import { Metric, MetricSource, ViewConfig, HierarchyLevel } from '../src/types';

const baseMetric = (code: string, col: string): Metric => ({
  metric_code: code, name: code, measure_type: 'base', fact_table: 'report_daily_sales',
  value_column: col, agg: 'SUM', formula: null, depends_on: [], additive: true,
  cost_sensitive: false, unit: '元', data_ready: true, enabled: true,
  description: null, business_formula: null,
});

// 叶级 hierarchy：store 级，复合门店键 grain，target 按 store 分解
const leafHierarchy: HierarchyLevel[] = [
  {
    level: 'store',
    grain: ['system_book_code', 'branch_num'],
    target_breakdown: 'store',
    is_leaf: true,
    columns: [
      { out: 'branch_name', expr: 'branch_name' },
      { out: 'war_zone', expr: 'first_level_region' },
      { out: 'region_l2', expr: 'second_level_region' },
    ],
  },
];

const saleSrc: MetricSource = {
  metric_code: 'sale_amount', source_table: 'report_daily_sales',
  source_column: 'total_sale', source_filter: null, note: null,
};

describe('Hierarchy Generator (T4 leaf level)', () => {
  it('叶级 actual CTE 按复合 grain 聚合 base 指标', () => {
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount'],
      dim_code: 'branch',
      levels: ['store'],
      target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: leafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale')], [saleSrc]);
    // base 聚合列
    expect(sql).toContain('SUM(s.total_sale) AS sale_amount');
    // 复合 grain（两列都出现，source 前缀）
    expect(sql).toContain('s.system_book_code');
    expect(sql).toContain('s.branch_num');
    // GROUP BY 含复合 grain
    expect(sql).toMatch(/GROUP BY[\s\S]*system_book_code[\s\S]*branch_num/);
    // tgt 窗口 CTE
    expect(sql).toContain('latest_day');
  });

  it('daily 指标在叶级 actual CTE 加 FILTER(latest_day) 列', () => {
    const dailyMetric: Metric = {
      ...baseMetric('daily_sale', 'total_sale'),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: 'sale_amount FILTER(biz_date=latest_day)', depends_on: ['sale_amount'],
      additive: true,
    };
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount', 'daily_sale'],
      dim_code: 'branch',
      levels: ['store'],
      target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: leafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), dailyMetric], [saleSrc]);
    expect(sql).toContain('FILTER (WHERE s.biz_date = tgt.latest_day)');
    expect(sql).toContain('AS daily_sale');
  });

  it('叶级 target CTE 按 target_breakdown 分解 target_metric_values', () => {
    const saleTarget: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount', 'sale_target'],
      dim_code: 'branch',
      levels: ['store'],
      target_metric_codes: ['sale_target'],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: leafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // breakdown_level 按叶级 target_breakdown
    expect(sql).toContain("breakdown_level = 'store'");
    // MAX(target_value) FILTER 聚合
    expect(sql).toContain('MAX(tmv.target_value)');
    expect(sql).toContain('AS sale_target');
    // source_filter 的 metric_code 条件透传
    expect(sql).toContain("metric_code='sale'");
    // target CTE 命名
    expect(sql).toContain('leaf_tgt AS (');
  });

  it('leaf_rows CTE cross join dim_branch + COALESCE + is_active + 窗口列', () => {
    const saleTarget: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount', 'sale_target'],
      dim_code: 'branch',
      levels: ['store'],
      target_metric_codes: ['sale_target'],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: leafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    expect(sql).toContain('leaf_rows AS (');
    expect(sql).toContain('CROSS JOIN dim_branch db');
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('db.is_active');
    expect(sql).toContain("db.branch_num <> '99'");
    // 考核战区过滤
    expect(sql).toContain('is_assessed_war_zone(db.first_level_region)');
    // 窗口列挂在 leaf_rows
    expect(sql).toContain('total_days');
    expect(sql).toContain('days_elapsed');
    // final SELECT 引用 leaf_rows（T5/T6 改此处）
    expect(sql).toContain('SELECT * FROM leaf_rows');
    // DROP + CREATE 视图
    expect(sql).toContain('DROP VIEW IF EXISTS v_leaf_test');
    expect(sql).toContain('CREATE VIEW v_leaf_test AS');
  });

  it('双 target 指标（sale+delivery）合一 leaf_tgt CTE', () => {
    const saleTarget: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
    const deliveryTarget: Metric = { ...baseMetric('delivery_target', 'target_value'), fact_table: null };
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount', 'sale_target', 'delivery_target'],
      dim_code: 'branch',
      levels: ['store'],
      target_metric_codes: ['sale_target', 'delivery_target'],
      scope: { target_window: true, assessed_war_zone: false },
      hierarchy: leafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget, deliveryTarget],
      [saleSrc,
        { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
        { metric_code: 'delivery_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='delivery'", note: null },
      ]);
    // 两个 target 列在同一 CTE（FILTER 分解）
    expect(sql).toContain('AS sale_target');
    expect(sql).toContain('AS delivery_target');
    // JOIN 条件 OR 合并两个 metric_code
    expect(sql).toMatch(/tmv\.target_id = t\.id AND \([\s\S]*metric_code='sale'[\s\S]*OR[\s\S]*metric_code='delivery'/);
    // 只有一个 leaf_tgt CTE 定义
    expect(sql.match(/leaf_tgt AS \(/g)).toHaveLength(1);
  });

  it('缺 is_leaf level 时抛错', () => {
    const config: ViewConfig = {
      view_name: 'v_leaf_test',
      metrics: ['sale_amount'],
      dim_code: 'branch',
      levels: ['region'],
      target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: [{ level: 'region', grain: ['war_zone'], target_breakdown: 'war_zone', is_leaf: false, columns: [] }],
    };
    expect(() => generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale')], [saleSrc])).toThrow(/is_leaf/);
  });
});

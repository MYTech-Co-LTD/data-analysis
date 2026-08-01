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
    // T6: final SELECT 从 leaf_rows 选列（FROM leaf_rows a），不再是 T4 占位
    expect(sql).toContain('FROM leaf_rows');
    expect(sql).not.toContain('SELECT * FROM leaf_rows');
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

// 含叶级 + 父级的多级 hierarchy（照手写视图 120 的 store + wz 两级）
const multiLevelHierarchy: HierarchyLevel[] = [
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
  {
    level: 'region',
    grain: ['war_zone'],
    target_breakdown: 'war_zone',
    is_leaf: false,
    rollup_from: 'store',
    columns: [],
  },
];

describe('Hierarchy Generator (T5 parent rollup + parent target)', () => {
  it('父级 actual rollup CTE 从 leaf_rows SUM additive + GROUP BY 父级 grain', () => {
    const saleTarget: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
    const config: ViewConfig = {
      view_name: 'v_parent_test',
      metrics: ['sale_amount', 'sale_target'],
      dim_code: 'branch',
      levels: ['store', 'region'],
      target_metric_codes: ['sale_target'],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: multiLevelHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // 父级 actual rollup CTE 存在，从 leaf_rows 聚合（列名=metric_code，与 T4 一致）
    expect(sql).toContain('region_act AS (');
    expect(sql).toMatch(/FROM leaf_rows/);
    expect(sql).toContain('SUM(sale_amount) AS sale_amount');
    // GROUP BY 含父级 grain（war_zone）
    expect(sql).toMatch(/GROUP BY[\s\S]*war_zone/);
    // 父级 target CTE 存在，按 war_zone breakdown
    expect(sql).toContain('region_tgt AS (');
    expect(sql).toContain("breakdown_level = 'war_zone'");
    expect(sql).toContain('AS sale_target');
    // 考核过滤用 t.war_zone（不 join dim_branch）
    expect(sql).toContain('is_assessed_war_zone(t.war_zone)');
    // leaf_rows 仍暴露 war_zone 列（rollup 前提）
    expect(sql).toContain('AS war_zone');
    // DROP + CREATE 视图
    expect(sql).toContain('DROP VIEW IF EXISTS v_parent_test');
    expect(sql).toContain('CREATE VIEW v_parent_test AS');
  });

  it('父级 target CTE 多指标 FILTER 合一且不 join dim_branch', () => {
    const saleTarget: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
    const deliveryTarget: Metric = { ...baseMetric('delivery_target', 'target_value'), fact_table: null };
    const config: ViewConfig = {
      view_name: 'v_parent_test',
      metrics: ['sale_amount', 'sale_target', 'delivery_target'],
      dim_code: 'branch',
      levels: ['store', 'region'],
      target_metric_codes: ['sale_target', 'delivery_target'],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: multiLevelHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), saleTarget, deliveryTarget],
      [saleSrc,
        { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
        { metric_code: 'delivery_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='delivery'", note: null },
      ]);
    // region_tgt 块内同时含两个 target 列
    const regionTgt = sql.match(/region_tgt AS \(([\s\S]*?)\n\)/);
    expect(regionTgt).toBeTruthy();
    expect(regionTgt![1]).toContain('AS sale_target');
    expect(regionTgt![1]).toContain('AS delivery_target');
    // 不 join dim_branch（targets 表自带 war_zone 列，照 120 wz_tgt）
    expect(regionTgt![1]).not.toContain('dim_branch');
    expect(regionTgt![1]).not.toMatch(/\bdb\./);
    // 全局只有一个 region_tgt 定义
    expect(sql.match(/region_tgt AS \(/g)).toHaveLength(1);
  });

  it('daily 指标与窗口列参与父级 actual rollup（SUM daily + MAX 窗口）', () => {
    const dailyMetric: Metric = {
      ...baseMetric('daily_sale', 'total_sale'),
      measure_type: 'derived', fact_table: null, value_column: null, agg: null,
      formula: 'sale_amount FILTER(biz_date=latest_day)', depends_on: ['sale_amount'],
      additive: true,
    };
    const config: ViewConfig = {
      view_name: 'v_parent_test',
      metrics: ['sale_amount', 'daily_sale'],
      dim_code: 'branch',
      levels: ['store', 'region'],
      target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: multiLevelHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale'), dailyMetric], [saleSrc]);
    // region_act 块
    const regionAct = sql.match(/region_act AS \(([\s\S]*?)\n\)/);
    expect(regionAct).toBeTruthy();
    expect(regionAct![1]).toContain('SUM(sale_amount) AS sale_amount');
    expect(regionAct![1]).toContain('SUM(daily_sale) AS daily_sale');
    expect(regionAct![1]).toContain('MAX(total_days) AS total_days');
    expect(regionAct![1]).toContain('MAX(days_elapsed) AS days_elapsed');
    // 无 target 列 rollup（daily-only config，无 target）
    expect(regionAct![1]).not.toMatch(/sale_target/);
  });

  it('leaf.columns 未暴露父级 grain 时自动补齐列（rollup 前提保障）', () => {
    // leaf 只暴露 branch_name，不暴露 war_zone；父级 region 的 columns 补 war_zone 映射
    const sparseLeafHierarchy: HierarchyLevel[] = [
      {
        level: 'store', grain: ['system_book_code', 'branch_num'], target_breakdown: 'store', is_leaf: true,
        columns: [{ out: 'branch_name', expr: 'branch_name' }],
      },
      {
        level: 'region', grain: ['war_zone'], target_breakdown: 'war_zone', is_leaf: false, rollup_from: 'store',
        columns: [{ out: 'war_zone', expr: 'first_level_region' }],
      },
    ];
    const config: ViewConfig = {
      view_name: 'v_sparse_test',
      metrics: ['sale_amount'],
      dim_code: 'branch',
      levels: ['store', 'region'],
      target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: true },
      hierarchy: sparseLeafHierarchy,
    };
    const sql = generateHierarchyView(config,
      [baseMetric('sale_amount', 'total_sale')], [saleSrc]);
    // leaf_rows 自动补 db.first_level_region AS war_zone
    expect(sql).toContain('db.first_level_region AS war_zone');
    expect(sql).toContain('region_act AS (');
  });
});

// 三级 hierarchy（照手写视图 120 的 store + sub_region + region）
const threeLevelHierarchy: HierarchyLevel[] = [
  {
    level: 'store',
    grain: ['system_book_code', 'branch_num'],
    target_breakdown: 'store',
    is_leaf: true,
    parent_expr: 'region_l2',
    columns: [
      { out: 'branch_num', expr: 'branch_num' },
      { out: 'branch_name', expr: 'branch_name' },
      { out: 'war_zone', expr: 'first_level_region' },
      { out: 'region_l2', expr: 'second_level_region' },
    ],
  },
  {
    level: 'sub_region',
    grain: ['war_zone', 'region_l2'],
    target_breakdown: 'region_l2',
    is_leaf: false,
    rollup_from: 'store',
    parent_expr: 'war_zone',
    columns: [
      { out: 'war_zone', expr: 'war_zone' },
      { out: 'region_l2', expr: 'region_l2' },
    ],
  },
  {
    level: 'region',
    grain: ['war_zone'],
    target_breakdown: 'war_zone',
    is_leaf: false,
    rollup_from: 'sub_region',
    // parent_expr 省略 → NULL::text AS parent_code（照 120 region 级）
    columns: [
      { out: 'war_zone', expr: 'war_zone' },
    ],
  },
];

// derived metric 构造辅助
const derivedMetric = (code: string, formula: string, depends_on: string[], additive = false): Metric => ({
  metric_code: code, name: code, measure_type: 'derived', fact_table: null, value_column: null, agg: null,
  formula, depends_on, additive, cost_sensitive: false, unit: '元', data_ready: true, enabled: true,
  description: null, business_formula: null,
});

describe('Hierarchy Generator (T6 final SELECT + UNION ALL)', () => {
  const saleM = baseMetric('sale_amount', 'total_sale');
  const saleTargetM: Metric = { ...baseMetric('sale_target', 'target_value'), fact_table: null };
  const saleRateM = derivedMetric('sale_rate', 'sale_amount/sale_target', ['sale_amount', 'sale_target']);
  const dailySaleM = derivedMetric('daily_sale', 'sale_amount FILTER(biz_date=latest_day)', ['sale_amount'], true);
  const remainingSaleM = derivedMetric(
    'remaining_daily_sale_target',
    '(sale_target - sale_amount) / greatest(total_days - days_elapsed, 1)',
    ['sale_target', 'sale_amount'],
  );

  const baseConfig = (metrics: Metric[], sources: MetricSource[], metricCodes: string[]): ViewConfig => ({
    view_name: 'v_three_level_test',
    metrics: metricCodes,
    dim_code: 'branch',
    levels: ['store', 'sub_region', 'region'],
    target_metric_codes: ['sale_target'],
    scope: { target_window: true, assessed_war_zone: true },
    hierarchy: threeLevelHierarchy,
  });

  it('三级 SELECT UNION ALL，每级输出 level 字面量', () => {
    const config = baseConfig(
      [saleM, saleTargetM, saleRateM, dailySaleM, remainingSaleM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target', 'sale_rate', 'daily_sale', 'remaining_daily_sale_target'],
    );
    const sql = generateHierarchyView(config,
      [saleM, saleTargetM, saleRateM, dailySaleM, remainingSaleM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // 三级 → 至少 2 个 UNION ALL
    expect((sql.match(/UNION ALL/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // 各级 level 字面量
    expect(sql).toContain(`'store' AS level`);
    expect(sql).toContain(`'sub_region' AS level`);
    expect(sql).toContain(`'region' AS level`);
    // 不再含 T4 占位 final SELECT
    expect(sql).not.toContain('SELECT * FROM leaf_rows');
    // DROP + CREATE 视图
    expect(sql).toContain('DROP VIEW IF EXISTS v_three_level_test');
    expect(sql).toContain('CREATE VIEW v_three_level_test AS');
  });

  it('每级 FROM 对应 act CTE；叶级 FROM leaf_rows，父级 FROM <level>_act', () => {
    const config = baseConfig(
      [saleM, saleTargetM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    expect(sql).toContain('FROM leaf_rows a');
    expect(sql).toContain('FROM sub_region_act a');
    expect(sql).toContain('FROM region_act a');
    // 父级 LEFT JOIN 该级 tgt CTE 取 target 列（复合 grain + target_id）
    expect(sql).toMatch(/LEFT JOIN sub_region_tgt t ON t\.target_id = a\.target_id AND t\.war_zone = a\.war_zone AND t\.region_l2 = a\.region_l2/);
    expect(sql).toMatch(/LEFT JOIN region_tgt t ON t\.target_id = a\.target_id AND t\.war_zone = a\.war_zone/);
  });

  it('store 级输出 branch_num 真值，region 级 branch_num 为 NULL::text', () => {
    const config = baseConfig(
      [saleM, saleTargetM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // store 级（叶级）按 leaf_rows 暴露的 out 引用 → a.branch_num AS branch_num
    expect(sql).toContain('a.branch_num AS branch_num');
    // region 级 columns 不含 branch_num → NULL::text AS branch_num
    expect(sql).toContain('NULL::text AS branch_num');
    // region 级输出 war_zone 真值（grain 元素，父级按 expr 引用）
    expect(sql).toContain('a.war_zone AS war_zone');
  });

  it('parent_code 按 level.parent_expr 取值；省略时 NULL::text', () => {
    const config = baseConfig(
      [saleM, saleTargetM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // store 级 parent_expr='region_l2' → a.region_l2 AS parent_code
    expect(sql).toContain('a.region_l2 AS parent_code');
    // sub_region 级 parent_expr='war_zone' → a.war_zone AS parent_code
    expect(sql).toContain('a.war_zone AS parent_code');
    // region 级省略 parent_expr → NULL::text AS parent_code
    expect(sql).toContain('NULL::text AS parent_code');
  });

  it('rate 指标重算：round(actual/nullif(target,0),4) 含 NULLIF', () => {
    const config = baseConfig(
      [saleM, saleTargetM, saleRateM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target', 'sale_rate'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM, saleRateM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // sale_rate 表达式含 NULLIF + round(...,4)
    expect(sql).toMatch(/round\([\s\S]*NULLIF\([\s\S]*,\s*0\)[\s\S]*,\s*4\)/);
    // 输出列名按 alias/code
    expect(sql).toContain('AS sale_rate');
  });

  it('remaining 指标：greatest 分母 → (target-actual)/GREATEST(total_days-days_elapsed,1)（月末最后一天按 1 天算）', () => {
    const config = baseConfig(
      [saleM, saleTargetM, remainingSaleM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target', 'remaining_daily_sale_target'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM, remainingSaleM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    // remaining 表达式含 a.total_days / a.days_elapsed
    expect(sql).toContain('a.total_days');
    expect(sql).toContain('a.days_elapsed');
    // 输出列名
    expect(sql).toContain('AS remaining_daily_sale_target');
    // greatest 分母 → GREATEST(diff, 1)，月末剩余 0 天不再 NULL
    expect(sql).toMatch(/GREATEST\(COALESCE\(a\.total_days, 0\) - COALESCE\(a\.days_elapsed, 0\), 1\)/);
    // round(...,2) 对齐 120 行 138-139
    expect(sql).toMatch(/round\([\s\S]*,\s*2\)/);
  });

  it('remaining 指标：nullif 分母（旧口径）→ NULLIF(diff, 0)，向后兼容', () => {
    const legacyRemainingM = derivedMetric(
      'remaining_daily_sale_target',
      '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)',
      ['sale_target', 'sale_amount'],
    );
    const config = baseConfig(
      [saleM, saleTargetM, legacyRemainingM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target', 'remaining_daily_sale_target'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM, legacyRemainingM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    expect(sql).toMatch(/NULLIF\(COALESCE\(a\.total_days, 0\) - COALESCE\(a\.days_elapsed, 0\), 0\)/);
    expect(sql).toContain('AS remaining_daily_sale_target');
  });

  it('daily 指标从 act CTE 直接引用（叶级 leaf_rows、父级 <level>_act 均已聚合）', () => {
    const config = baseConfig(
      [saleM, saleTargetM, dailySaleM], [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }],
      ['sale_amount', 'sale_target', 'daily_sale'],
    );
    const sql = generateHierarchyView(config, [saleM, saleTargetM, dailySaleM],
      [saleSrc, {
        metric_code: 'sale_target', source_table: 'target_metric_values',
        source_column: 'target_value', source_filter: "metric_code='sale'", note: null,
      }]);
    expect(sql).toContain('COALESCE(a.daily_sale, 0) AS daily_sale');
  });

  it('aliases 映射 metric_code → 输出列名', () => {
    const config: ViewConfig = {
      ...baseConfig([saleM], [saleSrc], ['sale_amount']),
      aliases: { sale_amount: 'sale_actual' },
    };
    const sql = generateHierarchyView(config, [saleM], [saleSrc]);
    expect(sql).toContain('AS sale_actual');
  });

  // ── 反自由发挥契约：抓 hierarchy 正则解析失败静默返 NULL ──
  // 覆盖 rate/remaining/daily/additive 全 derived 类型，用 129 规范化后的 formula 格式。
  // hierarchy.metricExpr 正则不匹配时返 'NULL' -> 生成 `NULL AS <alias>`。
  // 此测试断言每个 selected metric 都产出真实表达式，不降级为 NULL。
  it('契约：所有 selected metric 产出非 NULL 表达式（正则失败会暴露）', () => {
    const m = (c: string, col: string): Metric => baseMetric(c, col);
    const metrics: Metric[] = [
      m('sale_amount', 'total_sale'),
      { ...m('sale_target', 'target_value'), fact_table: 'target_metric_values' },
      m('delivery_amount', 'out_money'),
      { ...m('wholesale_pp_amount', 'wholesale_amount'), fact_table: 'report_daily_wholesale_customer' },
      { ...m('sale_rate', ''), measure_type: 'derived', fact_table: null, value_column: null, agg: null,
        formula: 'sale_amount / sale_target', depends_on: ['sale_amount', 'sale_target'], additive: false, unit: '率' },
      { ...m('daily_sale', ''), measure_type: 'derived', fact_table: null, value_column: null, agg: null,
        formula: 'sale_amount FILTER(biz_date=latest_day)', depends_on: ['sale_amount'], additive: true },
      { ...m('remaining_daily_sale', ''), measure_type: 'derived', fact_table: null, value_column: null, agg: null,
        formula: '(sale_target - sale_amount) / greatest(total_days - days_elapsed, 1)', depends_on: ['sale_target', 'sale_amount'], additive: true },
      { ...m('distribution_amount', ''), measure_type: 'derived', fact_table: null, value_column: null, agg: null,
        formula: 'delivery_amount + wholesale_pp_amount', depends_on: ['delivery_amount', 'wholesale_pp_amount'], additive: true },
    ];
    const sources: MetricSource[] = [
      saleSrc,
      { metric_code: 'sale_target', source_table: 'target_metric_values', source_column: 'target_value', source_filter: "metric_code='sale'", note: null },
      { metric_code: 'delivery_amount', source_table: 'report_daily_delivery', source_column: 'out_money', source_filter: null, note: null },
      { metric_code: 'wholesale_pp_amount', source_table: 'report_daily_wholesale_customer', source_column: 'wholesale_amount', source_filter: "system_book_code = '64188'", note: null },
    ];
    const config: ViewConfig = {
      ...baseConfig(metrics, sources, ['sale_amount', 'sale_target', 'sale_rate', 'daily_sale', 'remaining_daily_sale', 'distribution_amount']),
      aliases: { sale_amount: 'sale_actual', distribution_amount: 'delivery_actual', remaining_daily_sale: 'remaining_daily_sale_target' },
    };
    const sql = generateHierarchyView(config, metrics, sources);
    // 契约：每个指标 alias 都不能是裸 NULL 表达式（正则失败会产出 `NULL AS xxx`）
    expect(sql).not.toMatch(/NULL AS sale_actual/);
    expect(sql).not.toMatch(/NULL AS sale_target/);
    expect(sql).not.toMatch(/NULL AS sale_rate/);
    expect(sql).not.toMatch(/NULL AS daily_sale/);
    expect(sql).not.toMatch(/NULL AS remaining_daily_sale_target/);
    expect(sql).not.toMatch(/NULL AS delivery_actual/);
    // 正向：rate/remaining 含 NULLIF 或 greatest（确认走了解析分支而非降级）
    expect(sql).toMatch(/NULLIF|greatest/i);
  });
});

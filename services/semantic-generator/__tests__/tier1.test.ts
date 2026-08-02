import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { A } from '../src/ast';
import { Metric, MetricSource, ViewConfig } from '../src/types';

// 按真实 metric_registry（076/088/119/122/123）构造 fixture
const mockMetrics: Metric[] = [
  {
    metric_code: 'sale_amount',
    name: '销售金额',
    measure_type: 'base',
    fact_table: 'report_daily_sales',
    value_column: 'total_sale',
    agg: 'SUM',
    formula: null,
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
    metric_code: 'delivery_amount',
    name: '配送金额',
    measure_type: 'base',
    fact_table: 'report_daily_delivery',
    value_column: 'out_money',
    agg: 'SUM',
    formula: null,
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
    metric_code: 'wholesale_pp_amount',
    name: '批发-品品甜门店金额',
    measure_type: 'base',
    fact_table: 'report_daily_wholesale_customer',
    value_column: 'wholesale_amount',
    agg: 'SUM',
    formula: null,
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
    metric_code: 'wholesale_pp_profit',
    name: '批发-品品甜门店毛利',
    measure_type: 'base',
    fact_table: 'report_daily_wholesale_customer',
    value_column: 'wholesale_profit',
    agg: 'SUM',
    formula: null,
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
    metric_code: 'delivery_profit',
    name: '配送毛利',
    measure_type: 'base',
    fact_table: 'report_daily_delivery',
    value_column: 'profit_money',
    agg: 'SUM',
    formula: null,
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
    metric_code: 'distribution_amount',
    name: '配送金额',
    measure_type: 'derived',
    fact_table: null,
    value_column: null,
    agg: null,
    formula: 'delivery_amount + wholesale_pp_amount',
    formula_ast: A.op('+', A.ref('delivery_amount'), A.ref('wholesale_pp_amount')),
    depends_on: ['delivery_amount', 'wholesale_pp_amount'],
    additive: true,
    cost_sensitive: false,
    unit: '元',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
  {
    metric_code: 'distribution_profit',
    name: '配送毛利',
    measure_type: 'derived',
    fact_table: null,
    value_column: null,
    agg: null,
    formula: 'delivery_profit + wholesale_pp_profit',
    formula_ast: A.op('+', A.ref('delivery_profit'), A.ref('wholesale_pp_profit')),
    depends_on: ['delivery_profit', 'wholesale_pp_profit'],
    additive: true,
    cost_sensitive: true,
    unit: '元',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
  {
    metric_code: 'delivery_sale_ratio',
    name: '配销比',
    measure_type: 'derived',
    fact_table: null,
    value_column: null,
    agg: null,
    formula: 'distribution_amount / sale_amount',
    formula_ast: A.op('/', A.ref('distribution_amount'), A.ref('sale_amount')),
    depends_on: ['distribution_amount', 'sale_amount'],
    additive: false,
    cost_sensitive: false,
    unit: '率',
    data_ready: true,
    enabled: true,
    description: null,
    business_formula: null,
  },
];

const mockSources: MetricSource[] = [
  { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null },
  { metric_code: 'delivery_amount', source_table: 'report_daily_delivery', source_column: 'out_money', source_filter: null, note: null },
  { metric_code: 'delivery_profit', source_table: 'report_daily_delivery', source_column: 'profit_money', source_filter: null, note: null },
  { metric_code: 'wholesale_pp_amount', source_table: 'report_daily_wholesale_customer', source_column: 'wholesale_amount', source_filter: "s.system_book_code = '64188'", note: null },
  { metric_code: 'wholesale_pp_profit', source_table: 'report_daily_wholesale_customer', source_column: 'wholesale_profit', source_filter: "s.system_book_code = '64188'", note: null },
];

describe('Tier1 Generator', () => {
  it('should generate base aggregation for additive metrics', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['sale_amount', 'delivery_amount'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: [],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('SUM(s.total_sale) AS sale_amount');
    expect(sql).toContain('SUM(s.out_money) AS delivery_amount');
  });

  it('should expand additive derived metrics from formula (distribution)', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['distribution_amount'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: [],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // distribution_amount = delivery_amount + wholesale_pp_amount
    expect(sql).toContain('SUM(s.out_money)');
    expect(sql).toContain('SUM(s.wholesale_amount)');
  });

  it('should recalculate rate metrics (additive=false)', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['delivery_sale_ratio'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: [],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // 率重算：delivery_sale_ratio = distribution_amount / sale_amount
    // distribution_amount 展开为 delivery_amount + wholesale_pp_amount
    expect(sql).toContain('NULLIF');
    expect(sql).toContain('delivery_sale_ratio');
    // 检查展开式包含 delivery_amount + wholesale_pp_amount / sale_amount
    expect(sql).toContain('delivery_amount');
    expect(sql).toContain('sale_amount');
  });

  it('should apply cost masking for cost_sensitive=true', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['distribution_profit'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: [],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('request.jwt.claims.can_see_cost');
  });

  it('should respect source_filter in CTE (wholesale_pp brand)', () => {
    const config: ViewConfig = {
      view_name: 'report_brand_metric_gen',
      metrics: ['wholesale_pp_amount'],
      dim_code: 'brand',
      levels: ['brand'],
      target_metric_codes: [],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain("'64188'");
  });
});

describe('Tier1 dim_grain', () => {
  it('actual CTE join dim table 做 grain 变换 + extra 列', () => {
    const config: ViewConfig = {
      view_name: 'test_item_gen',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name', 'category_name'],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // actual CTE 含 JOIN dim_item + GROUP BY di.item_code + extra 列
    expect(sql).toContain('JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num');
    expect(sql).toContain('di.item_code');
    expect(sql).toContain('di.item_name');
    expect(sql).toContain('GROUP BY tgt.target_id, di.item_code');
    // 不含 s.item_num 作为 GROUP BY（grain 已变换）
    expect(sql).not.toMatch(/GROUP BY tgt\.target_id, s\.item_num/);
  });
});

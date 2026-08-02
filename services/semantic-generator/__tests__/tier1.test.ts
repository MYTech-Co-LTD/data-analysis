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

  it('extra 含生成列 category_group（裸列 MAX 携带，不改生成器）', () => {
    const config: ViewConfig = {
      view_name: 'test_item_cat_group',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name', 'category_group'],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('MAX(di.category_group) AS category_group');
    expect(sql).toContain('JOIN dim_item di');
  });

  it('lateral_pick 发 LATERAL join（本账套优先+跨品牌回退，LIMIT 1 不翻倍）', () => {
    const config: ViewConfig = {
      view_name: 'test_lateral_pick',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name'],
        lateral_pick: { match: 'item_num = s.item_num', prefer_own: 'system_book_code = s.system_book_code' },
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('JOIN LATERAL');
    expect(sql).toContain('SELECT * FROM dim_item WHERE item_num = s.item_num');
    expect(sql).toContain('ORDER BY (system_book_code = s.system_book_code) DESC');
    expect(sql).toContain('LIMIT 1');
    // 不含旧式精确 join 谓词作主 join
    expect(sql).not.toMatch(/JOIN dim_item di ON di\.system_book_code=s\.system_book_code/);
  });

  it('未设 lateral_pick 时仍发普通 join（回归）', () => {
    const config: ViewConfig = {
      view_name: 'test_no_lateral',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
        extra: ['item_name'],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('JOIN dim_item di ON di.system_book_code=s.system_book_code AND di.item_num=s.item_num');
    expect(sql).not.toContain('JOIN LATERAL');
  });
});

describe('Tier1 customer-view support', () => {
  it('dimKey 映射 customer→client_code', () => {
    const config: ViewConfig = {
      view_name: 't_cust_dimkey', metrics: ['wholesale_pp_amount'],
      dim_code: 'customer', levels: ['customer'], target_metric_codes: [],
      scope: { target_window: true },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('GROUP BY tgt.target_id, s.client_code');
    expect(sql).not.toMatch(/GROUP BY tgt\.target_id, s\.branch_num/);
  });

  it('carry_cols 带 MAX(s.col) 进 actual CTE', () => {
    const config: ViewConfig = {
      view_name: 't_cust_carry', metrics: ['wholesale_pp_amount'],
      dim_code: 'customer', levels: ['customer'], target_metric_codes: [],
      scope: { target_window: true },
      carry_cols: ['client_name', 'system_book_code'],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('MAX(s.client_name) AS client_name');
    expect(sql).toContain('MAX(s.system_book_code) AS system_book_code');
  });

  it('extra_join 标量子查询（避翻倍），WHERE 引用 firstCte 列', () => {
    const config: ViewConfig = {
      view_name: 't_cust_join', metrics: ['wholesale_pp_amount'],
      dim_code: 'customer', levels: ['customer'], target_metric_codes: [],
      scope: { target_window: true },
      carry_cols: ['client_name'],
      extra_join: {
        table: 'dim_branch db',
        on: { left: 'client_name', right: 'branch_name' },
        cols: [{ out: 'client_brand_code', expr: 'db.system_book_code' }],
      },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // 标量子查询 + LIMIT 1，WHERE 引用 cteN.client_name
    expect(sql).toMatch(/\(SELECT db\.system_book_code FROM dim_branch db WHERE db\.branch_name = cte\d+\.client_name LIMIT 1\) AS client_brand_code/);
    // 不含 LEFT JOIN dim_branch（避翻倍）
    expect(sql).not.toContain('LEFT JOIN dim_branch');
  });
});

describe('Tier1 source_override', () => {
  it('per-metric 重定向源表/列，CTE 按 override table 分组', () => {
    // mockSources 里 sale_amount→report_daily_sales；override 到 item 表
    const config: ViewConfig = {
      view_name: 't_override', metrics: ['sale_amount'], dim_code: 'item', levels: ['item'],
      target_metric_codes: [], scope: { target_window: true },
      dim_grain: { table: 'dim_item di', on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num', key: 'item_code' },
      source_override: { sale_amount: { table: 'report_daily_item_sales', column: 'sale_amount' } },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('FROM report_daily_item_sales s');
    expect(sql).toContain('SUM(s.sale_amount) AS sale_amount');
    expect(sql).not.toContain('FROM report_daily_sales');
  });
});

describe('Tier1 date grain', () => {
  it('dim_code=date: biz_date 作行 + latest_day 上限 + 无 dim_table cross-join', () => {
    const config: ViewConfig = {
      view_name: 't_date_grain',
      metrics: ['wholesale_pp_amount'],
      dim_code: 'date',
      levels: ['date'],
      target_metric_codes: [],
      scope: { target_window: true },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // dimKey 映射 date->biz_date：actual CTE GROUP BY 含 biz_date
    expect(sql).toContain('GROUP BY tgt.target_id, s.biz_date');
    // date grain 语义=时间序列罗列至当日，join 上限用 latest_day
    expect(sql).toContain('BETWEEN tgt.start_date AND tgt.latest_day');
    // 非 end_date（date 维度不走全周期累计，区别于其它维度）
    expect(sql).not.toMatch(/BETWEEN tgt\.start_date AND tgt\.end_date/);
    // date 无 dim_table，不 cross-join 维表
    expect(sql).not.toContain('CROSS JOIN');
    // final SELECT 输出 biz_date 列
    expect(sql).toMatch(/cte\d+\.biz_date AS biz_date/);
  });
});

describe('Tier1 extra_grain', () => {
  it('actual CTE GROUP BY 加 extra_grain 列 + final SELECT 输出 + FULL JOIN ON 含 extra_grain', () => {
    // 双 grain：customer(client_code) × date(biz_date)
    // sale_amount(report_daily_sales) + wholesale_pp_amount(report_daily_wholesale_customer) -> 2 CTE -> FULL JOIN
    const config: ViewConfig = {
      view_name: 'test_dual_grain',
      metrics: ['wholesale_pp_amount', 'sale_amount'],
      dim_code: 'customer',
      levels: ['customer'],
      target_metric_codes: [],
      scope: { target_window: true },
      extra_grain: ['s.biz_date'],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // actual CTE GROUP BY 含 extra_grain 列（与 client_code 并列）
    expect(sql).toContain('GROUP BY tgt.target_id, s.client_code, s.biz_date');
    // actual CTE SELECT 含 extra_grain 列
    expect(sql).toMatch(/SELECT tgt\.target_id, s\.client_code, s\.biz_date,/);
    // final SELECT 输出 extra_grain 列（去 s. 前缀作列名）
    expect(sql).toMatch(/cte\d+\.biz_date AS biz_date/);
    // 多 CTE FULL JOIN ON 含 extra_grain 列（防 cross join 翻倍）
    expect(sql).toMatch(/FULL OUTER JOIN cte\d+ ON cte\d+\.target_id = cte\d+\.target_id AND cte\d+\.client_code = cte\d+\.client_code AND cte\d+\.biz_date = cte\d+\.biz_date/);
  });

  it('无 extra_grain 时行为不变（回归）', () => {
    const config: ViewConfig = {
      view_name: 'test_no_extra_grain',
      metrics: ['wholesale_pp_amount'],
      dim_code: 'customer',
      levels: ['customer'],
      target_metric_codes: [],
      scope: { target_window: true },
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    expect(sql).toContain('GROUP BY tgt.target_id, s.client_code');
    // 不含 extra_grain 列输出
    expect(sql).not.toMatch(/cte\d+\.biz_date AS biz_date/);
  });

  it('与 carry_cols 兼容（extra_grain 是 GROUP BY，carry_cols 是 MAX）', () => {
    const config: ViewConfig = {
      view_name: 'test_grain_plus_carry',
      metrics: ['wholesale_pp_amount'],
      dim_code: 'customer',
      levels: ['customer'],
      target_metric_codes: [],
      scope: { target_window: true },
      carry_cols: ['client_name'],
      extra_grain: ['s.biz_date'],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // extra_grain 进 GROUP BY（grain）
    expect(sql).toContain('GROUP BY tgt.target_id, s.client_code, s.biz_date');
    // carry_cols 是 MAX（不进 GROUP BY）
    expect(sql).toContain('MAX(s.client_name) AS client_name');
    // final SELECT 两者都输出
    expect(sql).toMatch(/cte\d+\.biz_date AS biz_date/);
    expect(sql).toMatch(/cte\d+\.client_name AS client_name/);
  });

  it('与 dim_grain 兼容（extra_grain 追加到 grain key 之后）', () => {
    const config: ViewConfig = {
      view_name: 'test_grain_plus_dim_grain',
      metrics: ['sale_amount'],
      dim_code: 'item',
      levels: ['item'],
      target_metric_codes: [],
      scope: { target_window: true },
      dim_grain: {
        table: 'dim_item di',
        on: 'di.system_book_code=s.system_book_code AND di.item_num=s.item_num',
        key: 'item_code',
      },
      extra_grain: ['s.biz_date'],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // actual CTE GROUP BY: tgt.target_id, di.item_code, s.biz_date
    expect(sql).toContain('GROUP BY tgt.target_id, di.item_code, s.biz_date');
    // final SELECT 输出 item_code + biz_date
    expect(sql).toMatch(/cte\d+\.item_code AS item_code/);
    expect(sql).toMatch(/cte\d+\.biz_date AS biz_date/);
  });

  it('extra_grain biz_date 用 latest_day 上限（同 dim_code=date，至当日非全周期）', () => {
    // 双 grain：customer(client_code) × date(biz_date) 时间序列
    // dim_code='customer' 但 extra_grain 含 biz_date -> dateUpper 应走 tgt.latest_day（同 dim_code='date'）
    const config: ViewConfig = {
      view_name: 'test_extra_grain_date',
      metrics: ['wholesale_pp_amount'],
      dim_code: 'customer',
      levels: ['customer'],
      target_metric_codes: [],
      scope: { target_window: true },
      extra_grain: ['s.biz_date'],
    };
    const sql = generateTier1View(config, mockMetrics, mockSources);
    // join 上限用 latest_day（至当日，与主视图口径一致）
    expect(sql).toContain('BETWEEN tgt.start_date AND tgt.latest_day');
    // 不用 end_date 作 join 上限（end_date 是全周期含未来，下钻会与主视图漂移）
    expect(sql).not.toMatch(/BETWEEN tgt\.start_date AND tgt\.end_date/);
  });
});

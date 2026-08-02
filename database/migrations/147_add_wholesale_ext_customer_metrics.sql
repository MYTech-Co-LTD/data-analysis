-- 147_add_wholesale_ext_customer_metrics.sql
-- 语义层新增 3 个客户级外部批发指标（source=report_daily_wholesale_customer, filter='3120'）：
--   1. wholesale_ext_customer_amount  客户级外部批发金额（base, SUM wholesale_amount WHERE sbc=3120）
--   2. wholesale_ext_customer_profit  客户级外部批发毛利（base, 成本敏感, SUM wholesale_profit WHERE sbc=3120）
--   3. wholesale_ext_customer_margin   客户级外部批发毛利率（derived = profit / amount, 成本敏感）
--
-- 用途：看板2「外部批发日报」点日期下钻客户明细（双 grain: customer × biz_date）
--   视图 report_wholesale_daily_customer_gen（view-config: extra_grain=['s.biz_date']）
--
-- 与现有 wholesale_ext_*（品牌级，source=report_daily_wholesale 无 client）区别：
--   - wholesale_ext_* = report_daily_wholesale（品牌聚合，无 client_code，用于日报时间序列）
--   - wholesale_ext_customer_* = report_daily_wholesale_customer（客户粒度，有 client_code，用于下钻）
--   两者口径一致（同 WHERE 3120），SUM 相等（已验证 1960965.80），仅粒度不同。
--
-- 铁律：新增指标 = 改 metric_registry（AST 数据）+ metric_sources（数据源映射），不动生成器代码。
--   '3120' 在 metric_sources.source_filter（数据驱动配置），非代码字面量（与 wholesale_ext/wholesale_pp 同模式）。
-- 幂等：INSERT ... ON CONFLICT DO UPDATE。

-- ===== 1. metric_registry =====
INSERT INTO metric_registry
  (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg,
   depends_on, additive, cost_sensitive, unit, data_ready, enabled, formula_ast)
VALUES
  -- 1. 客户级外部批发金额（base）
  ('wholesale_ext_customer_amount', '客户级外部批发金额',
   '总部->外部批发客户金额（sbc=3120，客户粒度；SUM report_daily_wholesale_customer.wholesale_amount）',
   'SUM(wholesale_amount) WHERE system_book_code = 3120',
   'base', 'wholesale_detail', 'wholesale_money', 'SUM',
   NULL, true, false, '元', true, true, NULL),

  -- 2. 客户级外部批发毛利（base, 成本敏感）
  ('wholesale_ext_customer_profit', '客户级外部批发毛利',
   '总部->外部批发客户毛利（sbc=3120，客户粒度，成本敏感；SUM report_daily_wholesale_customer.wholesale_profit）',
   'SUM(wholesale_profit) WHERE system_book_code = 3120',
   'base', 'wholesale_detail', 'wholesale_profit', 'SUM',
   NULL, true, true, '元', true, true, NULL),

  -- 3. 客户级外部批发毛利率（derived = profit / amount, additive=false, 成本敏感）
  ('wholesale_ext_customer_margin', '客户级外部批发毛利率',
   '客户级外部批发毛利率 = wholesale_ext_customer_profit / wholesale_ext_customer_amount',
   'wholesale_ext_customer_profit / wholesale_ext_customer_amount',
   'derived', NULL, NULL, NULL,
   '["wholesale_ext_customer_profit","wholesale_ext_customer_amount"]'::jsonb, false, true, '%', true, true,
   '{"l":{"t":"ref","code":"wholesale_ext_customer_profit"},"r":{"t":"ref","code":"wholesale_ext_customer_amount"},"t":"op","op":"/"}'::jsonb)

ON CONFLICT (metric_code) DO UPDATE SET
  name             = EXCLUDED.name,
  description      = EXCLUDED.description,
  business_formula = EXCLUDED.business_formula,
  measure_type     = EXCLUDED.measure_type,
  fact_table       = EXCLUDED.fact_table,
  value_column     = EXCLUDED.value_column,
  agg              = EXCLUDED.agg,
  depends_on       = EXCLUDED.depends_on,
  additive         = EXCLUDED.additive,
  cost_sensitive   = EXCLUDED.cost_sensitive,
  unit             = EXCLUDED.unit,
  data_ready       = EXCLUDED.data_ready,
  enabled          = EXCLUDED.enabled,
  formula_ast      = EXCLUDED.formula_ast;

-- ===== 2. metric_sources（2 base 指标的数据源映射）=====
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('wholesale_ext_customer_amount', 'report_daily_wholesale_customer', 'wholesale_amount',
   's.system_book_code = ''3120''', '客户级外部批发（3120，客户粒度；与 wholesale_ext 同口径不同粒度）'),
  ('wholesale_ext_customer_profit', 'report_daily_wholesale_customer', 'wholesale_profit',
   's.system_book_code = ''3120''', '客户级外部批发毛利（3120，成本敏感）')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

-- ===== 验证 =====
DO $$
DECLARE
  missing_reg  TEXT;
  missing_src  TEXT;
BEGIN
  -- metric_registry 验证
  SELECT string_agg(metric_code, ', ') INTO missing_reg
  FROM (VALUES
    ('wholesale_ext_customer_amount'),
    ('wholesale_ext_customer_profit'),
    ('wholesale_ext_customer_margin')
  ) AS v(metric_code)
  WHERE NOT EXISTS (SELECT 1 FROM metric_registry WHERE metric_code = v.metric_code);

  IF missing_reg IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 147: metric_registry 缺失: %', missing_reg;
  END IF;

  -- metric_sources 验证（2 base 指标须有源映射）
  SELECT string_agg(metric_code, ', ') INTO missing_src
  FROM (VALUES
    ('wholesale_ext_customer_amount'),
    ('wholesale_ext_customer_profit')
  ) AS v(metric_code)
  WHERE NOT EXISTS (
    SELECT 1 FROM metric_sources
    WHERE metric_code = v.metric_code AND source_table = 'report_daily_wholesale_customer'
  );

  IF missing_src IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 147: metric_sources 缺失或表名错误: %', missing_src;
  END IF;

  -- derived margin 须有 formula_ast
  IF NOT EXISTS (
    SELECT 1 FROM metric_registry
    WHERE metric_code = 'wholesale_ext_customer_margin' AND formula_ast IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Migration 147: wholesale_ext_customer_margin formula_ast 为空';
  END IF;

  RAISE NOTICE 'Migration 147: 3 个客户级外部批发指标注册完成（amount/profit base + margin derived）';
END $$;

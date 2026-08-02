-- 146_add_daily_delivery_and_wholesale_ext_margin.sql
-- 语义层补齐 4 个 derived 指标（含 formula_ast JSONB）：
--   1. daily_delivery_amount   当天配送金额 = filter(delivery_amount by biz_date=latest_day)
--   2. daily_delivery_profit   当天配送毛利 = filter(delivery_profit by biz_date=latest_day)
--   3. daily_delivery_margin   当天配送毛利率 = daily_delivery_profit / daily_delivery_amount
--   4. wholesale_ext_margin    外部批发毛利率 = wholesale_ext_profit / wholesale_ext_amount
--
-- 用途：供应链出库层级报表（daily_delivery_amount/profit/margin）+ 外部批发日报（wholesale_ext_margin）
--
-- 口径要点：
--   - daily_delivery_amount/profit 引用 delivery_amount/delivery_profit（纯 delivery，
--     report_daily_delivery.out_money/profit_money），不含品品甜批发；
--     与已存在的 daily_delivery（引用 distribution_amount 含品品甜）刻意区分。
--   - margin 为比率，additive=false（不可跨维度简单相加）。
--   - 依赖含成本敏感指标的派生率（daily_delivery_margin 依赖 daily_delivery_profit；
--     wholesale_ext_margin 依赖 wholesale_ext_profit）cost_sensitive=true，确保脱敏传播。
--
-- 铁律：新增指标 = 改 metric_registry（AST 数据），不动生成器代码。
-- 幂等：INSERT ... ON CONFLICT (metric_code) DO UPDATE。

INSERT INTO metric_registry
  (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg,
   depends_on, additive, cost_sensitive, unit, data_ready, enabled, formula_ast)
VALUES
  -- 1. 当天配送金额（纯 delivery，不含品品甜批发）
  ('daily_delivery_amount', '当天配送金额',
   '当天(biz_date=latest_day)配送金额，口径=delivery_amount（report_daily_delivery.out_money，纯配送不含品品甜批发）',
   'filter(delivery_amount by biz_date=latest_day)',
   'derived', NULL, NULL, NULL,
   '["delivery_amount"]'::jsonb, true, false, '元', true, true,
   '{"t":"filter","col":"biz_date","val":{"t":"ref","code":"latest_day"},"expr":{"t":"ref","code":"delivery_amount"}}'::jsonb),

  -- 2. 当天配送毛利（成本敏感）
  ('daily_delivery_profit', '当天配送毛利',
   '当天(biz_date=latest_day)配送毛利，口径=delivery_profit（report_daily_delivery.profit_money，纯配送不含品品甜批发），成本敏感',
   'filter(delivery_profit by biz_date=latest_day)',
   'derived', NULL, NULL, NULL,
   '["delivery_profit"]'::jsonb, true, true, '元', true, true,
   '{"t":"filter","col":"biz_date","val":{"t":"ref","code":"latest_day"},"expr":{"t":"ref","code":"delivery_profit"}}'::jsonb),

  -- 3. 当天配送毛利率（率，additive=false；依赖 daily_delivery_profit 含成本，故 cost_sensitive=true）
  ('daily_delivery_margin', '当天配送毛利率',
   '当天配送毛利率 = daily_delivery_profit / daily_delivery_amount（纯配送口径，不含品品甜批发）',
   'daily_delivery_profit / daily_delivery_amount',
   'derived', NULL, NULL, NULL,
   '["daily_delivery_profit","daily_delivery_amount"]'::jsonb, false, true, '%', true, true,
   '{"l":{"t":"ref","code":"daily_delivery_profit"},"r":{"t":"ref","code":"daily_delivery_amount"},"t":"op","op":"/"}'::jsonb),

  -- 4. 外部批发毛利率（率，additive=false；依赖 wholesale_ext_profit 含成本，故 cost_sensitive=true）
  ('wholesale_ext_margin', '外部批发毛利率',
   '外部批发毛利率 = wholesale_ext_profit / wholesale_ext_amount',
   'wholesale_ext_profit / wholesale_ext_amount',
   'derived', NULL, NULL, NULL,
   '["wholesale_ext_profit","wholesale_ext_amount"]'::jsonb, false, true, '%', true, true,
   '{"l":{"t":"ref","code":"wholesale_ext_profit"},"r":{"t":"ref","code":"wholesale_ext_amount"},"t":"op","op":"/"}'::jsonb)

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

-- ===== 验证 =====
DO $$
DECLARE
  missing TEXT;
BEGIN
  SELECT string_agg(metric_code, ', ') INTO missing
  FROM (VALUES
    ('daily_delivery_amount'), ('daily_delivery_profit'),
    ('daily_delivery_margin'), ('wholesale_ext_margin')
  ) AS v(metric_code)
  WHERE NOT EXISTS (
    SELECT 1 FROM metric_registry
    WHERE metric_code = v.metric_code AND formula_ast IS NOT NULL
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 146: 下列指标缺失或 formula_ast 为空: %', missing;
  END IF;

  RAISE NOTICE 'Migration 146: 4 个 derived 指标注册完成（daily_delivery_amount/profit/margin + wholesale_ext_margin）';
END $$;

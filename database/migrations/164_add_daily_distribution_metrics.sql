-- 164_add_daily_distribution_metrics.sql
-- 语义层补齐 3 个 derived 指标（含 formula_ast JSONB）：
--   1. daily_distribution_amount   当天配送金额 = filter(distribution_amount by biz_date=latest_day)
--   2. daily_distribution_profit   当天配送毛利 = filter(distribution_profit by biz_date=latest_day)
--   3. daily_distribution_margin   当天配送毛利率 = daily_distribution_profit / daily_distribution_amount
--
-- 用途：供应链出库层级报表口径从纯 delivery 改为 distribution（含品品甜批发）后，
--       当天列需要 distribution 口径的当天版本。周期列直接用 distribution_amount/profit/margin。
--
-- 口径要点：
--   - distribution = delivery_amount + wholesale_pp_amount（熊喵配送 + 品品甜门店批发），
--     故 daily_distribution_* 含品品甜批发，与 daily_delivery_*（纯 delivery，不含品品甜）刻意区分。
--   - daily_distribution_amount/profit 引用 distribution_amount/distribution_profit（derived）。
--   - margin 为比率，additive=false（不可跨维度简单相加）。
--   - daily_distribution_profit 引用 distribution_profit（cost_sensitive），故 margin 亦 cost_sensitive=true，
--     确保脱敏传播（无成本权限返 NULL）。
--
-- 背景：supplyChainOutboundView 原用 daily_delivery_amount/profit/margin（纯 delivery，146 建立），
--       仅含熊喵（report_daily_delivery 只有 sbc=3120），品品甜配送走 wholesale_pp 无处可看。
--       改 distribution 口径对齐 region_breakdown（配送报表早已 distribution 口径）。
--
-- 铁律：新增指标 = 改 metric_registry（AST 数据），不动生成器代码。
-- 幂等：INSERT ... ON CONFLICT (metric_code) DO UPDATE。

INSERT INTO metric_registry
  (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg,
   depends_on, additive, cost_sensitive, unit, data_ready, enabled, formula_ast)
VALUES
  -- 1. 当天配送金额（distribution 口径，含品品甜批发）
  ('daily_distribution_amount', '当天配送金额',
   '当天(biz_date=latest_day)配送金额，口径=distribution_amount（delivery + wholesale_pp，含品品甜批发）',
   'filter(distribution_amount by biz_date=latest_day)',
   'derived', NULL, NULL, NULL,
   '["distribution_amount"]'::jsonb, true, false, '元', true, true,
   '{"t":"filter","col":"biz_date","val":{"t":"ref","code":"latest_day"},"expr":{"t":"ref","code":"distribution_amount"}}'::jsonb),

  -- 2. 当天配送毛利（distribution 口径，成本敏感）
  ('daily_distribution_profit', '当天配送毛利',
   '当天(biz_date=latest_day)配送毛利，口径=distribution_profit（delivery_profit + wholesale_pp_profit，含品品甜批发），成本敏感',
   'filter(distribution_profit by biz_date=latest_day)',
   'derived', NULL, NULL, NULL,
   '["distribution_profit"]'::jsonb, true, true, '元', true, true,
   '{"t":"filter","col":"biz_date","val":{"t":"ref","code":"latest_day"},"expr":{"t":"ref","code":"distribution_profit"}}'::jsonb),

  -- 3. 当天配送毛利率（率，additive=false；依赖 daily_distribution_profit 含成本，故 cost_sensitive=true）
  ('daily_distribution_margin', '当天配送毛利率',
   '当天配送毛利率 = daily_distribution_profit / daily_distribution_amount（distribution 口径，含品品甜批发）',
   'daily_distribution_profit / daily_distribution_amount',
   'derived', NULL, NULL, NULL,
   '["daily_distribution_profit","daily_distribution_amount"]'::jsonb, false, true, '%', true, true,
   '{"l":{"t":"ref","code":"daily_distribution_profit"},"r":{"t":"ref","code":"daily_distribution_amount"},"t":"op","op":"/"}'::jsonb)

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
    ('daily_distribution_amount'), ('daily_distribution_profit'),
    ('daily_distribution_margin')
  ) AS v(metric_code)
  WHERE NOT EXISTS (
    SELECT 1 FROM metric_registry
    WHERE metric_code = v.metric_code AND formula_ast IS NOT NULL
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 164: 下列指标缺失或 formula_ast 为空: %', missing;
  END IF;

  RAISE NOTICE 'Migration 164: 3 个 derived 指标注册完成（daily_distribution_amount/profit/margin）';
END $$;

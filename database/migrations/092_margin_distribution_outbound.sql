-- 092_margin_distribution_outbound.sql
-- 补全配送毛利率、出库毛利率定义（derived: profit / amount）
-- 配送毛利率 = distribution_profit / distribution_amount
-- 出库毛利率 = outbound_profit / outbound_amount
-- 与销售 margin(profit/amount) 同构；比率不累加(additive=false)；多源下钻视图不支持比率，仅在汇总/achievement 层算
-- 幂等: INSERT ON CONFLICT DO UPDATE

INSERT INTO metric_registry
  (metric_code, name, description, business_formula, measure_type, depends_on, additive, cost_sensitive, unit, data_ready, enabled)
VALUES
  ('distribution_margin', '配送毛利率',
   '配送毛利除以配送金额。口径：distribution_profit / distribution_amount（四大战区配送 + 品品甜门店批发）',
   'distribution_profit / distribution_amount',
   'derived',
   '["distribution_profit","distribution_amount"]'::jsonb,
   false, true, '%', true, true),
  ('outbound_margin', '出库毛利率',
   '出库毛利除以出库金额。口径：outbound_profit / outbound_amount（配送 + 品品甜门店批发 + 外部客户批发，均四大战区口径）',
   'outbound_profit / outbound_amount',
   'derived',
   '["outbound_profit","outbound_amount"]'::jsonb,
   false, true, '%', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name            = EXCLUDED.name,
  description     = EXCLUDED.description,
  business_formula = EXCLUDED.business_formula,
  measure_type    = EXCLUDED.measure_type,
  depends_on      = EXCLUDED.depends_on,
  additive        = EXCLUDED.additive,
  cost_sensitive  = EXCLUDED.cost_sensitive,
  unit            = EXCLUDED.unit;

DO $$ BEGIN RAISE NOTICE 'Migration 092: 注册 distribution_margin / outbound_margin（配送/出库毛利率 derived）'; END $$;

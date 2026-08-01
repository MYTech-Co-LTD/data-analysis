-- 122_delivery_sale_ratio_metric.sql
-- 语义层补齐「配销比」派生指标：配送金额 / 销售金额。
--   配送口径 = distribution_amount（调拨3120 + 品品甜批发64188），与 report_region_breakdown_v.delivery_actual 一致；
--   销售口径 = sale_amount（门店零售）。
--   派生率值，不落库，不随维度简单相加（additive=false）。
-- 幂等：ON CONFLICT DO UPDATE。
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, depends_on, additive, cost_sensitive, unit, data_ready, enabled) VALUES
('delivery_sale_ratio', '配销比', '配送金额 / 销售金额', '配送金额 ÷ 销售金额（配送=调拨+品品甜批发，与销售同门店口径）', 'derived', NULL, NULL, NULL, '["distribution_amount","sale_amount"]'::jsonb, false, false, '率', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;
DO $$ BEGIN RAISE NOTICE 'Migration 122: metric_registry 加 配销比(delivery_sale_ratio)'; END $$;

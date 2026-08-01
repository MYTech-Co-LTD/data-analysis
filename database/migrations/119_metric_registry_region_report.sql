-- 119_metric_registry_region_report.sql
-- 门店零售/配送报表的派生指标定义（语义层真相源；report_region_breakdown_v 照实现）。
-- target 来自 target_metric_values（按分解级），actual 来自 report_daily_sales / 配送(调拨+品品甜批发)。
-- 幂等：ON CONFLICT DO UPDATE。
INSERT INTO metric_registry (metric_code, name, description, measure_type, fact_table, value_column, agg, formula, depends_on, additive, unit, data_ready, enabled) VALUES
('sale_target', '销售目标', 'target_metric_values(target_value) metric_code=sale 按分解级(store/region_l2/war_zone)', 'base', 'target_metric_values', 'target_value', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('delivery_target', '配送目标', 'target_metric_values(target_value) metric_code=delivery 按分解级', 'base', 'target_metric_values', 'target_value', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('sale_rate', '销售完成率', 'sale_amount / sale_target', 'derived', NULL, NULL, NULL, 'sale_amount / sale_target', '["sale_amount","sale_target"]'::jsonb, false, '率', true, true),
('delivery_rate', '配送完成率', 'delivery_amount(配送口径) / delivery_target', 'derived', NULL, NULL, NULL, 'delivery_amount / delivery_target', '["delivery_amount","delivery_target"]'::jsonb, false, '率', true, true),
('daily_sale', '当日销售', 'sale_amount 当天(biz_date=LEAST(current_date,end_date))', 'derived', NULL, NULL, NULL, 'sale_amount FILTER(biz_date=latest_day)', '["sale_amount"]'::jsonb, true, '元', true, true),
('daily_delivery', '当日配送', 'delivery_amount 当天', 'derived', NULL, NULL, NULL, 'delivery_amount FILTER(biz_date=latest_day)', '["delivery_amount"]'::jsonb, true, '元', true, true),
('remaining_daily_sale', '剩余日均销售目标', '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)', 'derived', NULL, NULL, NULL, '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)', '["sale_target","sale_amount"]'::jsonb, true, '元', true, true),
('remaining_daily_delivery', '剩余日均配送目标', '(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)', 'derived', NULL, NULL, NULL, '(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)', '["delivery_target","delivery_amount"]'::jsonb, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, measure_type=EXCLUDED.measure_type,
  fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column, agg=EXCLUDED.agg,
  formula_ast =EXCLUDED.formula, depends_on=EXCLUDED.depends_on, unit=EXCLUDED.unit;
DO $$ BEGIN RAISE NOTICE 'Migration 119: metric_registry 加 region 报表 8 派生指标'; END $$;

-- 123_semantic_orphans_and_targets.sql
-- 补齐语义层：6 孤儿指标 + 2 outbound target 度量 + 结构化 metric_sources（target 度量的 source_filter）
-- 幂等：INSERT ON CONFLICT DO UPDATE；部署后 restart postgrest。
-- 关联：spec docs/superpowers/specs/2026-07-31-semantic-layer-generator-wiring-design.md §3

BEGIN;

-- ===== 1. 2 个 outbound target 度量（base，target_metric_values）=====
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, formula, depends_on, additive, cost_sensitive, unit, data_ready, enabled) VALUES
  ('outbound_amount_target','出库金额目标','target_metric_values(target_value) metric_code=outbound_amt 按分解级','SUM(target_value) WHERE metric_code=outbound_amt','base','target_metric_values','target_value','SUM',NULL,'[]'::jsonb,true,false,'元',true,true),
  ('outbound_profit_target','出库毛利目标','target_metric_values(target_value) metric_code=outbound_profit 按分解级','SUM(target_value) WHERE metric_code=outbound_profit','base','target_metric_values','target_value','SUM',NULL,'[]'::jsonb,true,false,'元',true,true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula =EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column,
  agg=EXCLUDED.agg, additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- ===== 2. 6 个孤儿指标（derived）=====
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, formula, depends_on, additive, cost_sensitive, unit, data_ready, enabled) VALUES
  ('delivery_margin','配送毛利率','配送毛利/配送金额','delivery_profit / delivery_amount','derived','profit / amount','["delivery_profit","delivery_amount"]'::jsonb,false,true,'%',true,true),
  ('profit_rate','利润完成率','出库毛利/出库毛利目标','outbound_profit / outbound_profit_target','derived','actual / target','["outbound_profit","outbound_profit_target"]'::jsonb,false,false,'率',true,true),
  ('daily_amount','当日出库金额','outbound_amount 当天(biz_date=latest_day)','outbound_amount FILTER(biz_date=latest_day)','derived','amount FILTER(latest_day)','["outbound_amount"]'::jsonb,true,false,'元',true,true),
  ('daily_profit','当日出库毛利','outbound_profit 当天','outbound_profit FILTER(biz_date=latest_day)','derived','amount FILTER(latest_day)','["outbound_profit"]'::jsonb,true,true,'元',true,true),
  ('daily_profit_margin','当日出库毛利率','daily_profit / daily_amount','daily_profit / daily_amount','derived','profit / amount','["daily_profit","daily_amount"]'::jsonb,false,true,'%',true,true),
  ('remaining_daily_profit_target','剩余日均利润目标','(outbound_profit_target - outbound_profit) / nullif(remaining_days,0)','(target - actual) / nullif(remaining_days, 0)','derived','(target - actual) / remaining','["outbound_profit","outbound_profit_target"]'::jsonb,true,false,'元',true,true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula =EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, formula_ast =EXCLUDED.formula, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- ===== 3. metric_sources：结构化 target 度量 source_filter =====
-- 119 注册了 sale_target/delivery_target 但没补 metric_sources 行；此处补齐 4 个 target 度量
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
SELECT v.metric_code, v.source_table, v.source_column, v.source_filter, v.note
FROM (VALUES
  ('sale_target','target_metric_values','target_value','metric_code=''sale''','销售目标（target_metric_values metric_code=sale）'),
  ('delivery_target','target_metric_values','target_value','metric_code=''delivery''','配送目标'),
  ('outbound_amount_target','target_metric_values','target_value','metric_code=''outbound_amt''','出库金额目标'),
  ('outbound_profit_target','target_metric_values','target_value','metric_code=''outbound_profit''','出库毛利目标')
) AS v(metric_code, source_table, source_column, source_filter, note)
WHERE EXISTS (SELECT 1 FROM metric_registry WHERE metric_code = v.metric_code)
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

COMMIT;

DO $$ BEGIN RAISE NOTICE 'Migration 123: 6 orphans + 2 outbound targets + 4 target metric_sources'; END $$;

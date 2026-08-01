-- 133_add_category_metrics.sql
-- 补充类别相关指标（语义层真相源；生成器依赖）
-- 幂等：INSERT ... ON CONFLICT DO UPDATE

-- ===== 1. 补充 metric_registry（base 指标）=====
-- delivery_amount/delivery_profit 已存在，仅更新名称（从"配送-熊喵门店金额"改为"配送金额"，品牌无关）
-- wholesale_amount/wholesale_profit 新增 base 指标
INSERT INTO metric_registry (metric_code, name, description, measure_type, fact_table, value_column, agg, depends_on, additive, unit, data_ready, enabled) VALUES
('delivery_amount', '配送金额', 'report_daily_delivery.out_money 配送金额', 'base', 'report_daily_delivery', 'out_money', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('delivery_profit', '配送毛利', 'report_daily_delivery.profit_money 配送毛利', 'base', 'report_daily_delivery', 'profit_money', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('wholesale_amount', '批发金额', 'report_daily_wholesale.wholesale_money 批发金额', 'base', 'report_daily_wholesale', 'wholesale_money', 'SUM', NULL, '[]'::jsonb, true, '元', true, true),
('wholesale_profit', '批发毛利', 'report_daily_wholesale.wholesale_profit 批发毛利', 'base', 'report_daily_wholesale', 'wholesale_profit', 'SUM', NULL, '[]'::jsonb, true, '元', true, true)
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, measure_type=EXCLUDED.measure_type,
  fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column, agg=EXCLUDED.agg,
  additive=EXCLUDED.additive, unit=EXCLUDED.unit;

-- ===== 2. 更新 outbound 指标 formula_ast（简化为 delivery + wholesale）=====
UPDATE metric_registry SET
  formula_ast = '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_amount"}}'::jsonb
WHERE metric_code = 'outbound_amount';

UPDATE metric_registry SET
  formula_ast = '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_profit"}}'::jsonb
WHERE metric_code = 'outbound_profit';

-- ===== 3. 补充 metric_sources（数据来源映射）=====
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('delivery_amount', 'report_daily_delivery', 'out_money', NULL::text, NULL::text),
  ('delivery_profit', 'report_daily_delivery', 'profit_money', NULL::text, '成本敏感'),
  ('wholesale_amount', 'report_daily_wholesale', 'wholesale_money', NULL::text, NULL::text),
  ('wholesale_profit', 'report_daily_wholesale', 'wholesale_profit', NULL::text, '成本敏感')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

-- ===== 4. 验证 =====
DO $$
DECLARE
  missing_metrics TEXT;
  missing_sources TEXT;
BEGIN
  -- 验证 metric_registry
  SELECT string_agg(metric_code, ', ') INTO missing_metrics
  FROM (VALUES
    ('delivery_amount'), ('delivery_profit'), ('wholesale_amount'), ('wholesale_profit'), ('outbound_amount'), ('outbound_profit')
  ) AS v(metric_code)
  WHERE NOT EXISTS (SELECT 1 FROM metric_registry WHERE metric_code = v.metric_code);

  IF missing_metrics IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 133: 缺少 metric_registry 指标: %', missing_metrics;
  END IF;

  -- 验证 metric_sources
  SELECT string_agg(metric_code, ', ') INTO missing_sources
  FROM (VALUES
    ('delivery_amount'), ('delivery_profit'), ('wholesale_amount'), ('wholesale_profit')
  ) AS v(metric_code)
  WHERE NOT EXISTS (SELECT 1 FROM metric_sources WHERE metric_code = v.metric_code);

  IF missing_sources IS NOT NULL THEN
    RAISE EXCEPTION 'Migration 133: 缺少 metric_sources 映射: %', missing_sources;
  END IF;

  RAISE NOTICE 'Migration 133: 类别指标补充完成（4 base + 2 derived formula_ast 更新 + 4 source 映射）';
END $$;
-- 088_metric_restructure.sql
-- 指标体系重构（配送/出库概念 + wholesale 拆品品甜门店/外部客户）
-- 业务概念：配送=总部→两品牌门店（熊喵delivery+品品甜wholesale_pp）；出库=总部→所有客户（+外部wholesale_ext）
-- 1. delivery：明确为总部→熊喵门店（配送调拨）
-- 2. wholesale 拆 wholesale_pp（品品甜门店 sbc=64188）+ wholesale_ext（外部客户 sbc=3120）
-- 3. 加 distribution（配送 = delivery + wholesale_pp）
-- 4. outbound 改名「出库」（= delivery + wholesale_pp + wholesale_ext）
-- 幂等：DELETE/INSERT ON CONFLICT/UPDATE；部署后重启 postgrest

BEGIN;

-- ===== metric_registry =====
-- 1. delivery 明确为「总部→熊喵门店」
UPDATE metric_registry SET
  description = '总部→熊喵鲜生门店（配送调拨，3120 内部；SUM out_money；is_assessed_war_zone 过滤）',
  business_formula = '熊喵门店 out_money 之和（四大战区）'
WHERE metric_code = 'delivery_amount';
UPDATE metric_registry SET
  description = '总部→熊喵鲜生门店配送毛利（SUM profit_money，成本敏感）',
  business_formula = '熊喵门店 profit_money 之和（四大战区；成本敏感）'
WHERE metric_code = 'delivery_profit';

-- 2. 删 wholesale（拆 pp + ext）
DELETE FROM metric_registry WHERE metric_code IN ('wholesale_amount','wholesale_profit');

-- 3. 加 wholesale_pp（品品甜门店）+ wholesale_ext（外部客户）
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, additive, cost_sensitive, unit) VALUES
  ('wholesale_pp_amount','批发-品品甜门店金额','总部→品品甜门店（批发；client 匹配品品甜门店，sbc=64188；SUM wholesale_money）','品品甜门店 wholesale_money 之和（四大战区）','base','wholesale_detail','wholesale_money','SUM',true,false,'元'),
  ('wholesale_pp_profit','批发-品品甜门店毛利','总部→品品甜门店批发毛利（sbc=64188，成本敏感）','品品甜门店 wholesale_profit 之和（四大战区；成本敏感）','base','wholesale_detail','wholesale_profit','SUM',true,true,'元'),
  ('wholesale_ext_amount','批发-外部客户金额','总部→外部批发客户（非门店；sbc=3120，branch_num=99；SUM wholesale_money）','外部客户 wholesale_money 之和','base','wholesale_detail','wholesale_money','SUM',true,false,'元'),
  ('wholesale_ext_profit','批发-外部客户毛利','总部→外部客户批发毛利（sbc=3120，成本敏感）','外部客户 wholesale_profit 之和（成本敏感）','base','wholesale_detail','wholesale_profit','SUM',true,true,'元')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column,
  agg=EXCLUDED.agg, additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- 4. 加 distribution（配送 = delivery + wholesale_pp，总部→两品牌门店）
INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, formula, depends_on, additive, cost_sensitive, unit) VALUES
  ('distribution_amount','配送金额','总部→两品牌门店（熊喵配送调拨 + 品品甜门店批发）','delivery_amount + wholesale_pp_amount','derived','delivery_amount + wholesale_pp_amount','["delivery_amount","wholesale_pp_amount"]',true,false,'元'),
  ('distribution_profit','配送毛利','总部→两品牌门店配送毛利','delivery_profit + wholesale_pp_profit','derived','delivery_profit + wholesale_pp_profit','["delivery_profit","wholesale_pp_profit"]',true,true,'元')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula=EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, formula=EXCLUDED.formula, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

-- 5. outbound 改「出库」（= delivery + wholesale_pp + wholesale_ext，总部→所有客户）
UPDATE metric_registry SET
  name = '出库金额',
  description = '总部→所有客户（熊喵配送 + 品品甜门店批发 + 外部客户批发）',
  business_formula = 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
  formula = 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
  depends_on = '["delivery_amount","wholesale_pp_amount","wholesale_ext_amount"]'
WHERE metric_code = 'outbound_amount';
UPDATE metric_registry SET
  name = '出库毛利',
  description = '总部→所有客户出库毛利',
  business_formula = 'delivery_profit + wholesale_pp_profit + wholesale_ext_profit',
  formula = 'delivery_profit + wholesale_pp_profit + wholesale_ext_profit',
  depends_on = '["delivery_profit","wholesale_pp_profit","wholesale_ext_profit"]'
WHERE metric_code = 'outbound_profit';

-- ===== metric_sources =====
-- 删旧 wholesale（CASCADE 已随 registry 删，显式保险）+ outbound 占位（derived 跨源无 source）
DELETE FROM metric_sources WHERE metric_code IN ('wholesale_amount','wholesale_profit','outbound_amount','outbound_profit');

-- 加 wholesale_pp / ext（source_filter 区分品品甜门店/外部）
INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note) VALUES
  ('wholesale_pp_amount','report_daily_wholesale','wholesale_money','s.system_book_code = ''64188''','品品甜门店（/compute 时 client_name 匹配品品甜 branch_name 标 64188）'),
  ('wholesale_pp_profit','report_daily_wholesale','wholesale_profit','s.system_book_code = ''64188''','品品甜门店，成本敏感'),
  ('wholesale_ext_amount','report_daily_wholesale','wholesale_money','s.system_book_code = ''3120''','外部客户（fallback 3120，branch_num=99，非门店）'),
  ('wholesale_ext_profit','report_daily_wholesale','wholesale_profit','s.system_book_code = ''3120''','外部客户，成本敏感')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

COMMIT;

DO $$ BEGIN RAISE NOTICE 'Migration 088: 指标重构 → 13 指标（sale×2 + delivery×2 + wholesale_pp×2 + wholesale_ext×2 + distribution×2 + outbound出库×2 + margin）'; END $$;

-- 130_formula_ast_column.sql
-- AST 化（反自由发挥核心）：metric_registry 加 formula_ast JSONB 列，存结构化 AST。
-- 生成器将改读 formula_ast 用 astToSql 递归翻译（纯 switch，无正则解析），杜绝自由发挥。
-- 过渡：保留 formula TEXT 列作人读/回退，1.4 生成器切换 + diff=0 验证后可删。
-- 幂等：ADD COLUMN IF NOT EXISTS + UPDATE WHERE formula_ast IS NULL。
-- 部署后 restart postgrest。

ALTER TABLE metric_registry ADD COLUMN IF NOT EXISTS formula_ast JSONB;

-- ===== rate（additive=false，A/B）=====
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"sale_amount"},"r":{"t":"ref","code":"sale_target"}}'::jsonb WHERE metric_code = 'sale_rate' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"distribution_amount"},"r":{"t":"ref","code":"delivery_target"}}'::jsonb WHERE metric_code = 'delivery_rate' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"distribution_amount"},"r":{"t":"ref","code":"sale_amount"}}'::jsonb WHERE metric_code = 'delivery_sale_ratio' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"delivery_amount"}}'::jsonb WHERE metric_code = 'delivery_margin' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"distribution_profit"},"r":{"t":"ref","code":"distribution_amount"}}'::jsonb WHERE metric_code = 'distribution_margin' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"sale_profit"},"r":{"t":"ref","code":"sale_amount"}}'::jsonb WHERE metric_code = 'margin' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"outbound_profit"},"r":{"t":"ref","code":"outbound_amount"}}'::jsonb WHERE metric_code = 'outbound_margin' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"outbound_profit"},"r":{"t":"ref","code":"outbound_profit_target"}}'::jsonb WHERE metric_code = 'profit_rate' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"ref","code":"daily_profit"},"r":{"t":"ref","code":"daily_amount"}}'::jsonb WHERE metric_code = 'daily_profit_margin' AND formula_ast IS NULL;

-- ===== additive derived（A + B [+ C]）=====
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_pp_amount"}}'::jsonb WHERE metric_code = 'distribution_amount' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_pp_profit"}}'::jsonb WHERE metric_code = 'distribution_profit' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"+","l":{"t":"op","op":"+","l":{"t":"ref","code":"delivery_amount"},"r":{"t":"ref","code":"wholesale_pp_amount"}},"r":{"t":"ref","code":"wholesale_ext_amount"}}'::jsonb WHERE metric_code = 'outbound_amount' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"+","l":{"t":"op","op":"+","l":{"t":"ref","code":"delivery_profit"},"r":{"t":"ref","code":"wholesale_pp_profit"}},"r":{"t":"ref","code":"wholesale_ext_profit"}}'::jsonb WHERE metric_code = 'outbound_profit' AND formula_ast IS NULL;

-- ===== daily（X FILTER(biz_date=latest_day)）=====
UPDATE metric_registry SET formula_ast = '{"t":"filter","expr":{"t":"ref","code":"sale_amount"},"col":"biz_date","val":{"t":"ref","code":"latest_day"}}'::jsonb WHERE metric_code = 'daily_sale' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"filter","expr":{"t":"ref","code":"distribution_amount"},"col":"biz_date","val":{"t":"ref","code":"latest_day"}}'::jsonb WHERE metric_code = 'daily_delivery' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"filter","expr":{"t":"ref","code":"outbound_amount"},"col":"biz_date","val":{"t":"ref","code":"latest_day"}}'::jsonb WHERE metric_code = 'daily_amount' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"filter","expr":{"t":"ref","code":"outbound_profit"},"col":"biz_date","val":{"t":"ref","code":"latest_day"}}'::jsonb WHERE metric_code = 'daily_profit' AND formula_ast IS NULL;

-- ===== remaining（(T-A) / greatest(total_days-days_elapsed, 1)）=====
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"op","op":"-","l":{"t":"ref","code":"sale_target"},"r":{"t":"ref","code":"sale_amount"}},"r":{"t":"call","fn":"greatest","args":[{"t":"op","op":"-","l":{"t":"ref","code":"total_days"},"r":{"t":"ref","code":"days_elapsed"}},{"t":"lit","v":1}]}}'::jsonb WHERE metric_code = 'remaining_daily_sale' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"op","op":"-","l":{"t":"ref","code":"delivery_target"},"r":{"t":"ref","code":"distribution_amount"}},"r":{"t":"call","fn":"greatest","args":[{"t":"op","op":"-","l":{"t":"ref","code":"total_days"},"r":{"t":"ref","code":"days_elapsed"}},{"t":"lit","v":1}]}}'::jsonb WHERE metric_code = 'remaining_daily_delivery' AND formula_ast IS NULL;
UPDATE metric_registry SET formula_ast = '{"t":"op","op":"/","l":{"t":"op","op":"-","l":{"t":"ref","code":"outbound_profit_target"},"r":{"t":"ref","code":"outbound_profit"}},"r":{"t":"call","fn":"greatest","args":[{"t":"op","op":"-","l":{"t":"ref","code":"total_days"},"r":{"t":"ref","code":"days_elapsed"}},{"t":"lit","v":1}]}}'::jsonb WHERE metric_code = 'remaining_daily_profit_target' AND formula_ast IS NULL;

-- 验证：derived 指标应全部有 formula_ast
DO $$ DECLARE missing text;
BEGIN
  SELECT string_agg(metric_code, ', ') INTO missing
  FROM metric_registry WHERE measure_type = 'derived' AND enabled AND formula_ast IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'Migration 130: 以下 derived 缺 formula_ast: %', missing;
  END IF;
  RAISE NOTICE 'Migration 130: formula_ast 列已加 + 20 个 derived AST 填充';
END $$;

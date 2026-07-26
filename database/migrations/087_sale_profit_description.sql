-- 087_sale_profit_description.sql
-- 校准 sale_profit 口径描述（两品牌四大战区毛利净额，成本敏感）
-- 幂等：UPDATE；部署后重启 postgrest

UPDATE metric_registry SET
  description = '两品牌四大战区零售毛利净额（SUM profit，退货负数自动净额；成本敏感 can_see_cost=false→NULL；is_assessed_war_zone 过滤）',
  business_formula = '四大战区门店 profit 之和（退货负数 → 净毛利；3120 熊喵 + 64188 品品合计；成本敏感）'
WHERE metric_code = 'sale_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 087: sale_profit 口径校准（两品牌四大战区毛利净额，成本敏感）'; END $$;

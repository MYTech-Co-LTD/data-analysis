-- 086_sale_amount_description.sql
-- 校准 sale_amount 口径描述（之前 A1 写"所有门店"，校准后明确"两品牌四大战区净额"）
-- 其它指标 description 待逐个确认口径后更新
-- 幂等：UPDATE；部署后重启 postgrest

UPDATE metric_registry SET
  description = '两品牌四大战区零售净额（SUM sale_money，退货负数自动净额；不含批发；is_assessed_war_zone 过滤，source_filter=NULL 品牌由 target 限）',
  business_formula = '四大战区门店 sale_money 之和（退货负数 → 净额；3120 熊喵 + 64188 品品合计）'
WHERE metric_code = 'sale_amount';

DO $$ BEGIN RAISE NOTICE 'Migration 086: sale_amount 口径描述校准（两品牌四大战区净额）'; END $$;

-- 127_region_delivery_distribution口径.sql
-- 下钻表 delivery 口径对齐 120：delivery_rate / daily_delivery 改为基于 distribution_amount
--   （配送 = 调拨3120 + 品品甜批发64188，与品牌表/KPI 一致）。
-- 这两个指标仅被 region_breakdown 报表使用（迁移119 注册时就是 region 专用），
--   原 formula 基于 delivery_amount（仅3120调拨），64188 门店配送漏算 → 对齐 120 改 distribution。
-- 幂等：UPDATE WHERE formula 是旧值；部署后 restart postgrest。

-- delivery_rate: delivery_amount / delivery_target → distribution_amount / delivery_target
UPDATE metric_registry SET
  formula = 'distribution_amount / delivery_target',
  depends_on = '["distribution_amount","delivery_target"]'::jsonb
WHERE metric_code = 'delivery_rate'
  AND formula = 'delivery_amount / delivery_target';

-- daily_delivery: delivery_amount FILTER(...) → distribution_amount FILTER(...)
UPDATE metric_registry SET
  formula = 'distribution_amount FILTER(biz_date=latest_day)',
  depends_on = '["distribution_amount"]'::jsonb
WHERE metric_code = 'daily_delivery'
  AND formula = 'delivery_amount FILTER(biz_date=latest_day)';

-- remaining_daily_delivery: (delivery_target - delivery_amount) → (delivery_target - distribution_amount)
UPDATE metric_registry SET
  formula = '(delivery_target - distribution_amount) / nullif(total_days - days_elapsed, 0)',
  depends_on = '["delivery_target","distribution_amount"]'::jsonb
WHERE metric_code = 'remaining_daily_delivery'
  AND formula = '(delivery_target - delivery_amount) / nullif(total_days - days_elapsed, 0)';

DO $$ BEGIN RAISE NOTICE 'Migration 127: delivery_rate/daily_delivery/remaining_daily_delivery 改 distribution 口径（对齐 120）'; END $$;

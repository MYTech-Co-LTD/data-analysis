-- 129_remaining_daily_last_day_greatest1.sql
-- 剩余日均目标月末边界口径：分母 nullif(total_days - days_elapsed, 0) → greatest(total_days - days_elapsed, 1)。
-- 背景：考核周期最后一天（或跨月回看时）days_elapsed = total_days → 剩余天数 0 → NULLIF 除零返回 NULL，
--   前端「剩余日均销售/配送目标」整列显示「—」（2026-07-31 实测全 NULL）。
-- 用户确认的口径（2026-07-31）：剩余天数为 0 时按 1 天算，即最后一天显示剩余缺口全额（今天要完成的量）。
-- 配套：services/semantic-generator hierarchy remaining 分支同步支持 greatest 分母；
--   生成产物 database/generated/report_region_breakdown_gen.sql 重新生成。
-- 幂等：UPDATE WHERE formula 是旧值；部署后 restart postgrest（视图重建须刷 schema 缓存）。

UPDATE metric_registry SET
  formula = '(sale_target - sale_amount) / greatest(total_days - days_elapsed, 1)',
  description = '(sale_target - sale_amount) / greatest(total_days - days_elapsed, 1)；月末最后一天剩余天数按 1 计'
WHERE metric_code = 'remaining_daily_sale'
  AND formula = '(sale_target - sale_amount) / nullif(total_days - days_elapsed, 0)';

UPDATE metric_registry SET
  formula = '(delivery_target - distribution_amount) / greatest(total_days - days_elapsed, 1)',
  description = '(delivery_target - distribution_amount) / greatest(total_days - days_elapsed, 1)；月末最后一天剩余天数按 1 计'
WHERE metric_code = 'remaining_daily_delivery'
  AND formula = '(delivery_target - distribution_amount) / nullif(total_days - days_elapsed, 0)';

DO $$ BEGIN RAISE NOTICE 'Migration 129: remaining_daily_sale/delivery 分母 nullif(...,0) → greatest(...,1)，月末最后一天按 1 天算'; END $$;

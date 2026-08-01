-- 127_region_delivery_distribution口径.sql
-- 下钻表 delivery 口径对齐 120：delivery_rate / daily_delivery 改为基于 distribution_amount
--   （配送 = 调拨3120 + 品品甜批发64188，与品牌表/KPI 一致）。
-- formula TEXT 列已在 136 删除（AST 化收口），本迁移历史使命已完成 → 守卫跳过。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'metric_registry' AND column_name = 'formula'
  ) THEN
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

    RAISE NOTICE 'Migration 127: delivery 口径已对齐 distribution';
  ELSE
    RAISE NOTICE 'Migration 127: formula 列已删除（AST 收口），跳过';
  END IF;
END $$;
-- 129_remaining_daily_last_day_greatest1.sql
-- 剩余日均目标月末边界口径：分母 nullif(total_days - days_elapsed, 0) → greatest(total_days - days_elapsed, 1)。
-- formula TEXT 列已在 136 删除（AST 化收口），本迁移历史使命已完成 → 守卫跳过。
-- （生成器 remaining 分支已直接支持 greatest 分母，不依赖 formula 文本）

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'metric_registry' AND column_name = 'formula'
  ) THEN
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

    RAISE NOTICE 'Migration 129b: remaining_daily 分母已改 greatest';
  ELSE
    RAISE NOTICE 'Migration 129b: formula 列已删除（AST 收口），跳过';
  END IF;
END $$;
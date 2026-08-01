-- 129_normalize_residual_abstract_formulas.sql
-- 规范化残留抽象 formula（AST 化前提 + 修 remaining_daily_profit_target 正则不匹配返 NULL）
-- formula TEXT 列已在 136 删除（AST 化收口），本迁移历史使命已完成 → 守卫跳过。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'metric_registry' AND column_name = 'formula'
  ) THEN
    UPDATE metric_registry SET formula = 'outbound_amount FILTER(biz_date=latest_day)'
    WHERE metric_code = 'daily_amount' AND formula = 'amount FILTER(latest_day)';

    UPDATE metric_registry SET formula = 'outbound_profit FILTER(biz_date=latest_day)'
    WHERE metric_code = 'daily_profit' AND formula = 'amount FILTER(latest_day)';

    UPDATE metric_registry SET formula = 'daily_profit / daily_amount'
    WHERE metric_code = 'daily_profit_margin' AND formula = 'profit / amount';

    UPDATE metric_registry SET formula = 'outbound_profit / outbound_profit_target'
    WHERE metric_code = 'profit_rate' AND formula = 'actual / target';

    UPDATE metric_registry SET formula = '(outbound_profit_target - outbound_profit) / greatest(total_days - days_elapsed, 1)'
    WHERE metric_code = 'remaining_daily_profit_target' AND formula = '(target - actual) / remaining';

    RAISE NOTICE 'Migration 129: 5 个残留抽象 formula 已规范化';
  ELSE
    RAISE NOTICE 'Migration 129: formula 列已删除（AST 收口），跳过';
  END IF;
END $$;
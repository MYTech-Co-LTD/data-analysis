-- 129_normalize_residual_abstract_formulas.sql
-- 规范化残留抽象 formula（AST 化前提 + 修 remaining_daily_profit_target 正则不匹配返 NULL）
-- 所有 formula 改用具体 metric_code + 标准语法（+/ FILTER / nullif / greatest）。
-- 幂等：UPDATE WHERE formula 是旧抽象值。部署后 restart postgrest。

-- daily_amount: amount FILTER(latest_day) -> outbound_amount FILTER(biz_date=latest_day)
UPDATE metric_registry SET formula = 'outbound_amount FILTER(biz_date=latest_day)'
WHERE metric_code = 'daily_amount' AND formula = 'amount FILTER(latest_day)';

-- daily_profit: amount FILTER(latest_day) -> outbound_profit FILTER(biz_date=latest_day)
UPDATE metric_registry SET formula = 'outbound_profit FILTER(biz_date=latest_day)'
WHERE metric_code = 'daily_profit' AND formula = 'amount FILTER(latest_day)';

-- daily_profit_margin: profit / amount -> daily_profit / daily_amount
UPDATE metric_registry SET formula = 'daily_profit / daily_amount'
WHERE metric_code = 'daily_profit_margin' AND formula = 'profit / amount';

-- profit_rate: actual / target -> outbound_profit / outbound_profit_target
UPDATE metric_registry SET formula = 'outbound_profit / outbound_profit_target'
WHERE metric_code = 'profit_rate' AND formula = 'actual / target';

-- remaining_daily_profit_target: (target - actual) / remaining
--   -> (outbound_profit_target - outbound_profit) / greatest(total_days - days_elapsed, 1)
--   分母用 greatest(...,1) 对齐 remaining_daily_sale/delivery 口径（月末最后一天显示剩余缺口全额，不归 NULL）
UPDATE metric_registry SET formula = '(outbound_profit_target - outbound_profit) / greatest(total_days - days_elapsed, 1)'
WHERE metric_code = 'remaining_daily_profit_target' AND formula = '(target - actual) / remaining';

DO $$ BEGIN RAISE NOTICE 'Migration 129: 规范化 5 个残留抽象 formula（daily_amount/daily_profit/daily_profit_margin/profit_rate/remaining_daily_profit_target）'; END $$;

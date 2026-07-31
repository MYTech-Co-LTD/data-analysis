-- 125_normalize_metric_formulas.sql
-- 规范化 metric_registry 公式：抽象名（profit/amount）→ 实际 metric_code
-- 使生成器可确定性展开 derived 指标。
-- 影响：margin = sale_profit/sale_amount；delivery_margin = delivery_profit/delivery_amount
-- 幂等：UPDATE WHERE formula 含抽象名；部署后 restart postgrest。

-- margin: profit/amount → sale_profit/sale_amount
UPDATE metric_registry SET formula = 'sale_profit / sale_amount'
WHERE metric_code = 'margin' AND formula = 'profit / amount';

-- delivery_margin: profit/amount → delivery_profit/delivery_amount
UPDATE metric_registry SET formula = 'delivery_profit / delivery_amount'
WHERE metric_code = 'delivery_margin' AND formula = 'profit / amount';

-- distribution_margin: profit/amount → distribution_profit/distribution_amount
UPDATE metric_registry SET formula = 'distribution_profit / distribution_amount'
WHERE metric_code = 'distribution_margin' AND formula = 'profit / amount';

-- outbound_margin: profit/amount → outbound_profit/outbound_amount
UPDATE metric_registry SET formula = 'outbound_profit / outbound_amount'
WHERE metric_code = 'outbound_margin' AND formula = 'profit / amount';

-- delivery_sale_ratio 已用 metric_code（distribution_amount/sale_amount），无需改
-- profit_rate: actual/target → outbound_profit/outbound_profit_target（待确认）
-- daily_profit_margin: profit/amount → daily_profit/daily_amount（待确认）

DO $$ BEGIN RAISE NOTICE 'Migration 125: 规范化 margin/delivery_margin/distribution_margin/outbound_margin 公式'; END $$;

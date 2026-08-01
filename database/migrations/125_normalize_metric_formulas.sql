-- 125_normalize_metric_formulas.sql
-- 规范化 metric_registry 公式：抽象名（profit/amount）→ 实际 metric_code
-- 使生成器可确定性展开 derived 指标。
-- 影响：margin = sale_profit/sale_amount；delivery_margin = delivery_profit/delivery_amount
-- 幂等：formula 列已在 136 删除（AST 化收口），本迁移改为 no-op 守卫。

-- formula TEXT 列已废弃（formula_ast 替代），本迁移历史使命已完成。
-- 保留守卫避免重跑报错。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'metric_registry' AND column_name = 'formula'
  ) THEN
    UPDATE metric_registry SET formula = 'sale_profit / sale_amount'
    WHERE metric_code = 'margin' AND formula = 'profit / amount';
    UPDATE metric_registry SET formula = 'delivery_profit / delivery_amount'
    WHERE metric_code = 'delivery_margin' AND formula = 'profit / amount';
    UPDATE metric_registry SET formula = 'distribution_profit / distribution_amount'
    WHERE metric_code = 'distribution_margin' AND formula = 'profit / amount';
    UPDATE metric_registry SET formula = 'outbound_profit / outbound_amount'
    WHERE metric_code = 'outbound_margin' AND formula = 'profit / amount';
    RAISE NOTICE 'Migration 125: formula 列仍存在，已规范化公式';
  ELSE
    RAISE NOTICE 'Migration 125: formula 列已删除（AST 收口），跳过';
  END IF;
END $$;
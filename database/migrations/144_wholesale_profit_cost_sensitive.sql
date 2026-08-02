-- 144_wholesale_profit_cost_sensitive.sql
-- wholesale_profit 应为成本敏感列（同 sale_profit/delivery_profit/outbound_profit）
-- 修复 registry cost_sensitive=false 遗漏：所有 gen 视图暴露了未脱敏 wholesale_profit。
-- 幂等 UPDATE。改后须重跑 gen-views（controller 负责）使视图重新生成带 CASE WHEN can_see_cost 脱敏。
UPDATE metric_registry SET cost_sensitive = true WHERE metric_code = 'wholesale_profit';
DO $$ BEGIN RAISE NOTICE 'Migration 144: wholesale_profit cost_sensitive=true'; END $$;

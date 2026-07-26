-- 090_wholesale_cost_aggregate.sql
-- report_daily_wholesale 加 wholesale_cost 列（随时观察 money-cost=profit 差异）
-- /compute daily_wholesale 加 SUM(wholesale_cost) + field_mapping 加 cost 映射
-- 幂等；部署后重启 postgrest + /compute 回填

-- 1. 加列
ALTER TABLE report_daily_wholesale ADD COLUMN IF NOT EXISTS wholesale_cost NUMERIC(14,2) DEFAULT 0;

-- 2. /compute sql_template 加 wholesale_cost（在 wholesale_money 后面插入）
UPDATE report_definitions SET sql_template = replace(
  sql_template,
  'as wholesale_money,',
  'as wholesale_money, CAST(SUM(CAST(wholesale_cost AS DECIMAL(14,2))) AS DECIMAL(14,2)) as wholesale_cost,'
) WHERE report_type = 'daily_wholesale' AND sql_template NOT LIKE '%wholesale_cost%';

-- 3. field_mapping 加 wholesale_cost
UPDATE report_definitions SET field_mapping = field_mapping || '{"wholesale_cost":{"type":"DECIMAL(14,2)","pg_column":"wholesale_cost"}}'::jsonb
WHERE report_type = 'daily_wholesale';

GRANT SELECT ON report_daily_wholesale TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 090: report_daily_wholesale 加 wholesale_cost + /compute 加 cost 聚合'; END $$;

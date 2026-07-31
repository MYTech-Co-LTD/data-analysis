-- 121_daily_reconcile_function.sql
-- 每日对账基础设施：compute 表 SUM 汇总 RPC + 结果记录表。
-- pipeline 完整性校验：表 SUM vs DuckDB parquet SUM（scheduler 层比对）。
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION。
CREATE TABLE IF NOT EXISTS reconcile_daily_results (
  id SERIAL PRIMARY KEY,
  check_date DATE NOT NULL,
  metric TEXT NOT NULL,
  table_sum NUMERIC(14,2),
  parquet_sum NUMERIC(14,2),
  diff NUMERIC(14,2),
  status TEXT,
  checked_at TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE FUNCTION reconcile_table_consistency(p_date DATE)
RETURNS TABLE(metric TEXT, table_sum NUMERIC, table_rows BIGINT)
LANGUAGE sql AS $$
  SELECT 'delivery'::text, sum(out_money), count(*)::bigint FROM report_daily_delivery WHERE biz_date = p_date
  UNION ALL SELECT 'wholesale', sum(wholesale_money), count(*)::bigint FROM report_daily_wholesale WHERE biz_date = p_date
  UNION ALL SELECT 'sales', sum(total_sale), count(*)::bigint FROM report_daily_sales WHERE biz_date = p_date
  UNION ALL SELECT 'item_outbound', sum(delivery_amount + wholesale_amount), count(*)::bigint FROM report_daily_item_outbound WHERE biz_date = p_date
  UNION ALL SELECT 'wholesale_customer', sum(wholesale_amount), count(*)::bigint FROM report_daily_wholesale_customer WHERE biz_date = p_date
$$;
GRANT EXECUTE ON FUNCTION reconcile_table_consistency(DATE) TO authenticated, anon;
GRANT SELECT ON reconcile_daily_results TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 121: reconcile_table_consistency + reconcile_daily_results'; END $$;

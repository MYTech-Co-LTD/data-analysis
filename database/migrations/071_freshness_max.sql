-- 071_freshness_max.sql
-- 修正 get_data_freshness: 返回行 { data_updated_at, last_query_at }，两时间分开展示。
--   - data_updated_at: 3 表最新一次 /compute 时间(MAX updated_at) 的最早(LEAST)
--     = "当前数据涉及的3个compute(sales/delivery/wholesale)中最早跑完的那个"，代表最旧表的新鲜度
--     (旧版用 MIN(updated_at) 取最旧行, 错; 应取各表最新compute的最早)
--   - last_query_at: collect_tasks.last_run_at 心跳（采集最近运行时间，系统活跃信号；
--     与 collect_stall 监控对齐——系统停才告警，数据旧(源头没数据)不告警)
-- 注意: 返回类型从标量 TIMESTAMPTZ 改为 TABLE 行，CREATE OR REPLACE 不允许改返回类型，
--       必须 DROP FUNCTION IF EXISTS 后重建（幂等）。

DROP FUNCTION IF EXISTS get_data_freshness();

CREATE OR REPLACE FUNCTION get_data_freshness()
RETURNS TABLE (data_updated_at timestamptz, last_query_at timestamptz)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    LEAST(
      (SELECT MAX(updated_at) FROM report_daily_sales),
      (SELECT MAX(updated_at) FROM report_daily_delivery),
      (SELECT MAX(updated_at) FROM report_daily_wholesale)),
    (SELECT MAX(last_run_at) FROM collect_tasks)
$$;
GRANT EXECUTE ON FUNCTION get_data_freshness() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 071_freshness_max completed'; END $$;

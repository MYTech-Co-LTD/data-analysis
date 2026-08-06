-- 153_qa_logs.sql
-- qa_logs: 语义层数据质量守护对账结果日志（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
-- 幂等: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / IF NOT EXISTS index

-- ===== qa_logs 表 =====
CREATE TABLE IF NOT EXISTS qa_logs (
    id         BIGSERIAL PRIMARY KEY,
    run_id     TEXT NOT NULL,
    trigger    TEXT NOT NULL,          -- 'cron' | 'collect' | 'deploy' | 'manual'
    check_type TEXT NOT NULL,          -- 'C0'..'C4' | 'D1' | 'D2'
    check_name TEXT NOT NULL,          -- 如 'D1:retail' / 'C2:report_brand_metric_gen'
    status     TEXT NOT NULL,          -- 'pass' | 'fail' | 'error' | 'no-data'（no-data=数据未到，独立预警不混 fail/error）
    diff       NUMERIC,
    detail     JSONB,
    run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(run_id, check_type, check_name)
);
-- 幂等加 CHECK（153 是 CREATE TABLE IF NOT EXISTS；表已存在时 ALTER 须先查 pg_constraint，否则重跑报 duplicate constraint）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'qa_logs_status_check' AND conrelid = 'qa_logs'::regclass
  ) THEN
    ALTER TABLE qa_logs ADD CONSTRAINT qa_logs_status_check
      CHECK (status IN ('pass', 'fail', 'error', 'no-data'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_qa_logs_run_at ON qa_logs(run_at DESC);
CREATE INDEX IF NOT EXISTS idx_qa_logs_status ON qa_logs(status);

GRANT SELECT, INSERT ON qa_logs TO anon;
GRANT SELECT, INSERT ON qa_logs TO authenticated;

-- ===== D2 聚合表 PK 重复检查 RPC =====
-- 表名白名单（防注入）; 动态 GROUP BY p_keys HAVING COUNT(*) > 1
CREATE OR REPLACE FUNCTION qa_d2_dup_rows(p_table TEXT, p_keys TEXT[])
RETURNS TABLE(dup_key TEXT, cnt BIGINT) AS $$
DECLARE
  key_list TEXT;
BEGIN
  IF p_table NOT IN (
    'report_daily_sales','report_daily_delivery','report_daily_wholesale',
    'report_daily_item_sales','report_daily_item_outbound','report_daily_wholesale_customer'
  ) THEN
    RAISE EXCEPTION 'qa_d2_dup_rows: forbidden table %', p_table;
  END IF;
  SELECT string_agg(quote_ident(k), ', ') INTO key_list FROM unnest(p_keys) AS k;
  IF key_list IS NULL THEN
    RAISE EXCEPTION 'qa_d2_dup_rows: empty p_keys';
  END IF;
  RETURN QUERY EXECUTE format(
    'SELECT concat_ws(''|'', %s) AS dup_key, COUNT(*) AS cnt FROM %I GROUP BY %s HAVING COUNT(*) > 1',
    key_list, p_table, key_list
  );
END; $$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION qa_d2_dup_rows(TEXT, TEXT[]) TO anon;
GRANT EXECUTE ON FUNCTION qa_d2_dup_rows(TEXT, TEXT[]) TO authenticated;

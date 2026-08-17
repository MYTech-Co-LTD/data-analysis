-- 189_push_payload_ttl.sql
-- 生产接线 清理项：push_trigger_payloads / push_trigger_logs TTL 7 天自动清理。
--   表注释即承诺 7 天 TTL（迁移 173），但从未有清理执行者 → 无限增长。
--   anon 只有 SELECT/INSERT → 不能直接 GRANT DELETE（anon key 广播面大）。
--   改用 SECURITY DEFINER RPC cleanup_push_audit(p_days)，带下限守卫（p_days >= 7，防误删近期审计）。
--   执行者：web/lib/jobs/push-ttl-cleanup（每日 job）。
-- 幂等：CREATE OR REPLACE + GRANT（重跑安全）。

CREATE OR REPLACE FUNCTION cleanup_push_audit(p_days INT DEFAULT 7)
RETURNS TABLE(payloads_deleted BIGINT, logs_deleted BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_cutoff TIMESTAMPTZ;
BEGIN
  -- 下限守卫：小于 7 天视为误用（审计排障窗口），拒绝
  IF p_days IS NULL OR p_days < 7 THEN
    RAISE EXCEPTION 'p_days must be >= 7 (audit troubleshooting window), got %', p_days;
  END IF;
  v_cutoff := now() - (p_days || ' days')::interval;

  DELETE FROM push_trigger_payloads WHERE created_at < v_cutoff;
  GET DIAGNOSTICS payloads_deleted = ROW_COUNT;

  DELETE FROM push_trigger_logs WHERE created_at < v_cutoff;
  GET DIAGNOSTICS logs_deleted = ROW_COUNT;
END;
$$;

COMMENT ON FUNCTION cleanup_push_audit(INT) IS '推送审计 TTL 清理：删除 created_at 早于 p_days（>=7）前的 push_trigger_payloads / push_trigger_logs 行';

GRANT EXECUTE ON FUNCTION cleanup_push_audit(INT) TO anon, authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 189_push_payload_ttl applied'; END $$;

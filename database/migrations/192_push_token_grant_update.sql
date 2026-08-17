-- 192_push_token_grant_update.sql
-- 生产接线（2026-08-18 E2E 发现）：novu-client upsert bridge_token 用
--   Prefer: resolution=merge-duplicates → INSERT ... ON CONFLICT DO UPDATE
--   → 需 UPDATE 权限；175 只给了 anon INSERT/SELECT → 每次生成 bridge_token 必
--   42501 permission denied → getRecipientInfo 返回 null → 收件人全部 skipped、
--   push_subscriber_tokens 恒空（Novu webhookUrl 无从生成，整链路断）。
-- 幂等：GRANT 可重复执行；末尾断言。
GRANT INSERT, SELECT, UPDATE ON push_subscriber_tokens TO anon, authenticated;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_name = 'push_subscriber_tokens' AND grantee = 'anon' AND privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'migration 192 failed: anon UPDATE grant missing on push_subscriber_tokens';
  END IF;
  RAISE NOTICE 'Migration 192_push_token_grant_update applied';
END $$;

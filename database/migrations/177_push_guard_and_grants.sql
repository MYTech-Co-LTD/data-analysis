-- 177_push_guard_and_grants.sql
-- Review 修复（B1 补充 + B7）：
--   B1 补充：push_settings 表（guards.isPaused 读 key='paused'）——此前缺失导致
--     PostgREST 404 → isPaused fail-closed 恒 true → 引擎守卫 2 恒"已暂停"。
--     require_push_owner RPC 由 177_push_require_owner.sql 提供（本文件不重复定义，
--     避免 CREATE OR REPLACE 改返回类型冲突）。
--   B7：敏感表 anon 授权收口 —— bridge_token / outbox / 审计表的写、删、读不再对 anon 开放
--     （引擎 INSERT push_subscriber_tokens、bridge SELECT 仍走现有 key；SELECT 全面收口
--      + service-role key 迁移列为后续任务）。
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT ON CONFLICT / REVOKE 均可重跑。
BEGIN;

-- ① 暂停开关表（web/lib/push/guards.ts isPaused 读 key='paused'）
CREATE TABLE IF NOT EXISTS push_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO push_settings(key, value) VALUES ('paused', 'false')
  ON CONFLICT (key) DO NOTHING;
COMMENT ON TABLE push_settings IS '推送引擎设置（键值对）：paused=true 时引擎 fail-closed 暂停';

GRANT SELECT ON push_settings TO anon, authenticated;

-- ② anon 授权收口（B7）：
--    push_subscriber_tokens：高熵 bridge_token，删除/更新不对 anon 开放（SELECT 保留——bridge 现以
--      INSFORGE_API_KEY 读取，全面收口需 service-role key，列后续任务）。
--    sync_outbox：未完成写操作的完整性，删除不对 anon 开放（drain 用 UPDATE 标记 done，不需 DELETE）。
--    push_trigger_logs / push_trigger_payloads：审计快照（含收件人列表），读/写/删不对 anon 开放
--      （引擎以现有 key INSERT 保留）。
REVOKE DELETE, UPDATE ON push_subscriber_tokens FROM anon;
REVOKE DELETE ON sync_outbox FROM anon;
REVOKE SELECT, DELETE, UPDATE ON push_trigger_logs FROM anon;
REVOKE SELECT, DELETE, UPDATE ON push_trigger_payloads FROM anon;

COMMIT;

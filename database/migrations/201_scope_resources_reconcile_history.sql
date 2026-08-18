-- 201_scope_resources_reconcile_history.sql
-- 薄同步/对账 history（方案 A M5/spec-forge）：仿 group_reconcile_history（178 先例），
--   date PK 幂等 UPSERT；red_count>0 → notifyWecom 告警（对账接线，不静默）。
-- 幂等：CREATE TABLE IF NOT EXISTS / IF NOT EXISTS 索引。
BEGIN;

CREATE TABLE IF NOT EXISTS scope_resources_reconcile_history (
  date                   DATE PRIMARY KEY,                -- 北京时区自然日（cron 侧格式化）
  changed                INT  NOT NULL DEFAULT 0,         -- 投影被写回的用户数
  unchanged              INT  NOT NULL DEFAULT 0,         -- 投影已一致的用户数
  empty_keys             INT  NOT NULL DEFAULT 0,         -- 无范围资源键的用户数（deny 方向）
  red_count              INT  NOT NULL DEFAULT 0,         -- 红区：写时 fail-close / 解析失败 / 护栏 abort 计数
  detail                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scope_resources_reconcile_history_date
  ON scope_resources_reconcile_history(date);

GRANT SELECT ON scope_resources_reconcile_history TO anon, authenticated;

COMMIT;

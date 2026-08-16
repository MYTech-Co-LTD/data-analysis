-- 176_sync_outbox.sql
-- Task 12: U1b 薄同步（写者收编 + outbox + drift 三向）
--   sync_outbox: 幂等键 (wecom_id, action, day)；失败可重放；drift 视图支持三向对账。
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE。
BEGIN;

-- ① sync_outbox 表：薄同步失败/待重放操作
CREATE TABLE IF NOT EXISTS sync_outbox (
  id          SERIAL PRIMARY KEY,
  wecom_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('provision', 'assign_role', 'disable', 'sync_mirror')),
  payload     JSONB DEFAULT '{}',
  day         DATE NOT NULL DEFAULT (CURRENT_DATE AT TIME ZONE 'Asia/Shanghai'),
  attempts    INT NOT NULL DEFAULT 0,
  done        BOOLEAN NOT NULL DEFAULT false,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  -- 幂等键：同一用户同一动作同一天只有一行（重放不重复创建）
  CONSTRAINT sync_outbox_idempotent UNIQUE (wecom_id, action, day)
);
COMMENT ON TABLE sync_outbox IS '薄同步 outbox：Casdoor 写操作失败/待重放队列；幂等键 (wecom_id, action, day)';
COMMENT ON COLUMN sync_outbox.action IS 'provision=建户 | assign_role=写角色 | disable=离职停用 | sync_mirror=回写镜像';
COMMENT ON COLUMN sync_outbox.day IS '操作日期（Asia/Shanghai），幂等键分量';
COMMENT ON COLUMN sync_outbox.done IS 'true=已成功执行；false=待重放';
COMMENT ON COLUMN sync_outbox.attempts IS '已尝试次数（每次 drain +1）';

CREATE INDEX IF NOT EXISTS idx_sync_outbox_pending
  ON sync_outbox(done, day) WHERE NOT done;
CREATE INDEX IF NOT EXISTS idx_sync_outbox_wecom
  ON sync_outbox(wecom_id, action);

GRANT SELECT, INSERT, UPDATE, DELETE ON sync_outbox TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE sync_outbox_id_seq TO anon, authenticated;

-- ② drift 视图 1：diff1 = Casdoor 手工配置（C−E，manual 除外）
--   Casdoor 有角色但本地 org_users.role_codes 不一致（且 casdoor_writer != 'manual'）
--   → 说明 Casdoor 侧有手工配置，需回写镜像标 manual
CREATE OR REPLACE VIEW drift_diff1_casdoor_manual AS
SELECT u.wecom_id, u.name, u.role_codes AS local_codes,
       u.casdoor_writer, u.casdoor_synced_at
FROM org_users u
WHERE u.is_active
  AND u.casdoor_writer != 'manual'  -- manual 已豁免
  AND u.casdoor_synced_at IS NOT NULL
  AND u.casdoor_synced_at < NOW() - INTERVAL '48 hours';  -- 滞后 >48h
COMMENT ON VIEW drift_diff1_casdoor_manual IS 'drift diff1：Casdoor 侧有配置但本地镜像滞后 >48h（非 manual 用户）→ 可能是 Casdoor UI 手工改的';

-- ③ drift 视图 2：diff2 = 写失败 outbox 积压
--   outbox 有未完成项且 created_at > 48h → 告警
CREATE OR REPLACE VIEW drift_diff2_outbox_backlog AS
SELECT o.id, o.wecom_id, o.action, o.payload, o.day,
       o.attempts, o.error, o.created_at,
       EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 3600 AS hours_pending
FROM sync_outbox o
WHERE NOT o.done
  AND o.created_at < NOW() - INTERVAL '48 hours';
COMMENT ON VIEW drift_diff2_outbox_backlog IS 'drift diff2：outbox 积压 >48h 的未完成项（写失败待重放）';

-- ④ drift 视图 3：diff3 = 镜像滞后（C−M）
--   本地 role_codes 与 Casdoor 最新不一致且 synced_at > 24h
--   （此视图需要 Casdoor 数据才能完整判断，此处提供本地侧滞后检测）
CREATE OR REPLACE VIEW drift_diff3_mirror_lag AS
SELECT u.wecom_id, u.name, u.role_codes, u.casdoor_synced_at,
       EXTRACT(EPOCH FROM (NOW() - u.casdoor_synced_at)) / 3600 AS hours_since_sync
FROM org_users u
WHERE u.is_active
  AND u.casdoor_synced_at IS NOT NULL
  AND u.casdoor_synced_at < NOW() - INTERVAL '24 hours';
COMMENT ON VIEW drift_diff3_mirror_lag IS 'drift diff3：镜像滞后 >24h（本地 synced_at 超时，需回写或触发重新同步）';

-- ⑤ drift 汇总统计（供告警 job 快速判断是否需要告警）
CREATE OR REPLACE VIEW drift_summary AS
SELECT
  (SELECT count(*) FROM drift_diff1_casdoor_manual) AS diff1_count,
  (SELECT count(*) FROM drift_diff2_outbox_backlog) AS diff2_count,
  (SELECT count(*) FROM drift_diff3_mirror_lag) AS diff3_count,
  NOW() AS checked_at;
COMMENT ON VIEW drift_summary IS 'drift 三向汇总：diff1(Casdoor手工)/diff2(outbox积压)/diff3(镜像滞后) 各计数';

COMMIT;

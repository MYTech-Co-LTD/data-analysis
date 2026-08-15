-- 173_push_audit.sql
-- push 触发审计日志 + payload 快照
-- spec: S5 §5.3

-- 推送触发主日志
CREATE TABLE IF NOT EXISTS push_trigger_logs (
  txn_id UUID PRIMARY KEY,
  operator TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  selector JSONB NOT NULL,
  groups INT NOT NULL,
  recipients TEXT[] NOT NULL,
  scope_signatures TEXT[] NOT NULL,
  var_codes TEXT[] NOT NULL,
  skipped TEXT[] DEFAULT '{}',
  deliver_mode TEXT NOT NULL DEFAULT 'shadow', -- shadow | live
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 每组渲染 payload 快照
CREATE TABLE IF NOT EXISTS push_trigger_payloads (
  txn_id UUID NOT NULL,
  group_sig TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (txn_id, group_sig)
);

CREATE INDEX IF NOT EXISTS idx_ptp_ttl ON push_trigger_payloads(created_at);

GRANT SELECT, INSERT ON push_trigger_logs TO anon, authenticated;
GRANT SELECT, INSERT ON push_trigger_payloads TO anon, authenticated;

COMMENT ON TABLE push_trigger_logs IS '推送触发审计日志';
COMMENT ON TABLE push_trigger_payloads IS '推送 payload 快照（7 天 TTL）';

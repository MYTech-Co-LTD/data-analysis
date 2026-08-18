-- 175: push_subscriber_tokens — Novu bridge 每 subscriber 一个高熵 token
-- 用于 wecom-bridge 双层验签：Novu 签名 + engine_sig 内层 HMAC

CREATE TABLE IF NOT EXISTS push_subscriber_tokens (
  bridge_token TEXT PRIMARY KEY,        -- 32B hex 高熵，Novu webhookUrl 路径段
  wecom_id TEXT NOT NULL UNIQUE,        -- 企微 userid，发送目标
  created_at TIMESTAMPTZ DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriber_tokens TO anon, authenticated;

COMMENT ON TABLE push_subscriber_tokens IS 'Novu bridge 每 subscriber 一个高熵 token，用于双层验签';
COMMENT ON COLUMN push_subscriber_tokens.bridge_token IS '32B hex 高熵 token，Novu webhookUrl 路径段';
COMMENT ON COLUMN push_subscriber_tokens.wecom_id IS '企微 userid，发送目标';

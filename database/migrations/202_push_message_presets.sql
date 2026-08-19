-- 202_push_message_presets.sql
-- 推送消息呈现配置（平台能力，2026-08-20）：多消息类型（text/markdown/textcard/news/template_card）
--   由平台配置，引擎渲染 message_content（JSON 契约）进 payload，Novu content 固定 {{payload.message_content}}，
--   bridge 按 content JSON dispatch（web/lib/wecom-send.ts 多类型发送）。
-- 幂等：CREATE TABLE IF NOT EXISTS / IF NOT EXISTS 索引。
BEGIN;

CREATE TABLE IF NOT EXISTS push_message_presets (
  preset_id       TEXT PRIMARY KEY,            -- 全局唯一（建议 workflow_id 派生）
  workflow_id     TEXT NOT NULL,               -- 关联 Novu workflow（name）
  msgtype         TEXT NOT NULL DEFAULT 'markdown' CHECK (msgtype IN ('text','markdown','textcard','news','template_card')),
  title           TEXT,                        -- textcard.title / template_card.main_title / news 首条 title
  description     TEXT,                        -- textcard.description / news 首条 description
  url_var         TEXT,                        -- 取哪条推送变量的值作跳转 URL（如 detail_url）
  btntxt          TEXT,                        -- textcard 按钮文字
  articles_json   JSONB,                       -- news：完整 articles 数组（title/description/url/picurl）
  content_template TEXT,                       -- text/markdown：直接内容模板（可含 {{var}}）
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_message_presets_workflow ON push_message_presets(workflow_id);

GRANT SELECT, INSERT, UPDATE ON push_message_presets TO anon, authenticated;

COMMIT;

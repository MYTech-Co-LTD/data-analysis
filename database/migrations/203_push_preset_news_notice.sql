-- 203_push_preset_news_notice.sql
-- 推送消息统一 template_card news_notice（2026-08-20 用户裁定）：
--   1) push_message_presets 加 card_json 列（完整 template_card 对象模板，{{var}} 深度插值）
--   2) scheduled-report preset 从 textcard 切换为 news_notice
--      （textcard.url 1024B 放不下 JWT 长链；news_notice 用 card_action 短链 /reports/targets，
--        企微会话自带权限——docs/ops/wecom-message-capabilities.md §2.2.2）
-- 幂等：ADD COLUMN IF NOT EXISTS / ON CONFLICT DO UPDATE。
BEGIN;

ALTER TABLE push_message_presets
  ADD COLUMN IF NOT EXISTS card_json JSONB;
COMMENT ON COLUMN push_message_presets.card_json IS 'template_card：完整 card 对象模板（news_notice 等 card_type；{{var}} 深度插值）';

INSERT INTO push_message_presets
  (preset_id, workflow_id, msgtype, title, description, url_var, btntxt,
   articles_json, content_template, card_json, enabled)
VALUES
  ('scheduled-report-card', 'scheduled-report', 'template_card',
   '📊 数据日报', '销售 {{sale_amount}} · 达成率 {{achievement_rate}}', NULL, NULL,
   NULL, NULL,
   '{
     "card_type": "news_notice",
     "source": {"desc": "山海数据平台", "desc_color": 1},
     "main_title": {"title": "📊 数据日报", "desc": "销售 {{sale_amount}} · 达成率 {{achievement_rate}}"},
     "card_image": {"url": "https://data.shanhaiyiguo.com/push/daily-report-banner.png", "aspect_ratio": 2.25},
     "vertical_content_list": [
       {"title": "销售额", "value": "{{sale_amount}}"},
       {"title": "达成率", "value": "{{achievement_rate}}"}
     ],
     "card_action": {"type": 1, "url": "https://data.shanhaiyiguo.com/reports/targets"}
   }'::jsonb,
   true)
ON CONFLICT (preset_id) DO UPDATE SET
  msgtype         = EXCLUDED.msgtype,
  title           = EXCLUDED.title,
  description     = EXCLUDED.description,
  url_var         = EXCLUDED.url_var,
  btntxt          = EXCLUDED.btntxt,
  articles_json   = EXCLUDED.articles_json,
  content_template= EXCLUDED.content_template,
  card_json       = EXCLUDED.card_json,
  enabled         = EXCLUDED.enabled,
  updated_at      = now();

COMMIT;

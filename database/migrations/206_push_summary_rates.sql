-- 206_push_summary_rates.sql
-- 摘要扩展（2026-08-22 用户要求）：卡片 source.desc 改目标名 + 摘要 5 指标（率）。
--   1) push_variables 注册 3 个率变量：
--      outbound_amt_rate（供应链出库目标完成率）/ outbound_profit_rate（供应链出库毛利完成率）
--      / outbound_margin（供应链毛利率 = outbound_profit/outbound_amt 派生，引擎特判计算）
--   2) scheduled-report-card preset：
--      source.desc = {{target_name}}（目标标题，引擎注入；查不到回退"山海数据平台"字面量）
--      main_title.title = 📊 数据日报（恢复）
--      horizontal_content_list 5 项（keyname+value 横向键值对，企微 ≤6 项边界内）
--      （迁移 203 的 ON CONFLICT DO UPDATE 每次部署重置 card_json，此处幂等 jsonb_set 保持配置）
-- 幂等：INSERT ON CONFLICT DO NOTHING / UPDATE jsonb_set 重复跑无害。
BEGIN;

INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('outbound_amt_rate', '供应链出库目标完成率', 'outbound_amt', 'total', NULL, '%', true),
  ('outbound_profit_rate', '供应链出库毛利完成率', 'outbound_profit', 'total', NULL, '%', true),
  ('outbound_margin', '供应链毛利率', 'outbound_profit', 'total', NULL, '%', true)
ON CONFLICT (var_code) DO NOTHING;

UPDATE push_message_presets
SET card_json = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(card_json, '{card_image,url}', '"{{report_banner}}"'::jsonb, true),
            '{card_action,url}', '"{{report_banner}}"'::jsonb, true
          ),
          '{source,desc}', '"{{target_name}}"'::jsonb, true
        ),
        '{main_title,title}', '"📊 数据日报"'::jsonb, true
      ),
      '{main_title,desc}', '"销售 {{sale_amount}} · 达成率 {{achievement_rate}}"'::jsonb, true
    ),
    '{horizontal_content_list}',
    jsonb_build_array(
      jsonb_build_object('keyname', '门店零售金额完成率', 'value', '{{achievement_rate}}'),
      jsonb_build_object('keyname', '门店配送金额完成率', 'value', '{{delivery_rate}}'),
      jsonb_build_object('keyname', '供应链出库目标完成率', 'value', '{{outbound_amt_rate}}'),
      jsonb_build_object('keyname', '供应链出库毛利完成率', 'value', '{{outbound_profit_rate}}'),
      jsonb_build_object('keyname', '供应链毛利率', 'value', '{{outbound_margin}}')
    )::jsonb,
    true
  ),
  updated_at = now()
WHERE preset_id = 'scheduled-report-card';

COMMIT;

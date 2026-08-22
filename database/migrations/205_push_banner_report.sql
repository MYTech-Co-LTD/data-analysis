-- 205_push_banner_report.sql
-- 报表数据横幅 report_banner（2026-08-21 设计 docs/superpowers/specs/2026-08-21-push-banner-report-design.md）：
--   1) push_variables 注册 report_banner（非数值指标，metric_code NULL，scope_dim='total' 占位——实际按组 scope 裁剪）
--   2) scheduled-report-card preset 的 card_image.url 从静态占位图升级为 {{report_banner}} 变量
--      （引擎模板引用才预渲染；未引用/解析失败 → message-preset 回退占位图，见 Task 5）
--   3) card_action.url 改 {{report_banner}}——点击卡片/图片打开横幅大图外链（全屏查看）
--   4) 摘要 horizontal_content_list（keyname+value 横向键值，≤6）+ source.desc={{target_name}}（目标标题）
--      + main_title.title=📊 数据日报（不变）+ main_title.desc=销售/达成率
--   5) 剔除 vertical_content_list——迁移 203 种子带 title+value 形式（企微 VerticalContent 不识别 value，
--      图片下方「销售额/达成率」值空残留，2026-08-22 用户反馈）；摘要已统一 horizontal。
--      （迁移 203 的 ON CONFLICT DO UPDATE 每次部署重置 card_json，此处幂等 jsonb_set 保持 banner/摘要配置）
-- 幂等：INSERT ON CONFLICT DO NOTHING / UPDATE jsonb_set 重复跑无害。
BEGIN;

INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('report_banner', '报表横幅', NULL, 'total', NULL, 'URL', true)
ON CONFLICT (var_code) DO NOTHING;

UPDATE push_message_presets
-- 先剔除 vertical_content_list（见注释 5），再逐层 jsonb_set 覆盖配置
SET card_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            (card_json - 'vertical_content_list'),
            '{card_image,url}', '"{{report_banner}}"'::jsonb, true
          ),
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

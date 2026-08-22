-- 205_push_banner_report.sql
-- 报表数据横幅 report_banner（2026-08-21 设计 docs/superpowers/specs/2026-08-21-push-banner-report-design.md）：
--   1) push_variables 注册 report_banner（非数值指标，metric_code NULL，scope_dim='total' 占位——实际按组 scope 裁剪）
--   2) scheduled-report-card preset 的 card_image.url 从静态占位图升级为 {{report_banner}} 变量
--      （引擎模板引用才预渲染；未引用/解析失败 → message-preset 回退占位图，见 Task 5）
--   3) card_action.url 改 {{report_banner}}——点击卡片/图片打开横幅大图外链（全屏查看）
--      （迁移 203 的 ON CONFLICT DO UPDATE 每次部署重置 card_json，此处幂等 jsonb_set 保持 banner 配置）
-- 幂等：INSERT ON CONFLICT DO NOTHING / UPDATE jsonb_set 重复跑无害。
BEGIN;

INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('report_banner', '报表横幅', NULL, 'total', NULL, 'URL', true)
ON CONFLICT (var_code) DO NOTHING;

UPDATE push_message_presets
SET card_json = jsonb_set(
    jsonb_set(card_json, '{card_image,url}', '"{{report_banner}}"'::jsonb, true),
    '{card_action,url}', '"{{report_banner}}"'::jsonb, true
  ),
    updated_at = now()
WHERE preset_id = 'scheduled-report-card';

COMMIT;

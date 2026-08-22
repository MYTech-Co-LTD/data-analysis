-- 208_push_daily_report_config.sql
-- 每日经营指标日报定时推送（2026-08-22 用户要求：每天 21:30，推给总经理 boss + 战区总 zone_manager 角色）。
--   1) 注册 push_configs 定时任务：cron_spec {kind:'daily', time:'21:30'}（宿主 job __scheduled_reports 每小时扫描 due）
--      selector {kind:'role', ids:['1','2']}——role 选择器 U2 已启用（route/engine 按 org_users.role_id 解析；
--      boss=1 总经理、zone_manager=2 战区总）
--      preset_id=scheduled-report-card（横幅报表卡）
--      target_mode=fixed / target_id=823（8 月经营指标，与测试推送一致；后续周期切换改 follow）
--      owner_wecom_id=ZhangDuo（push:configure 持有者，调度任务 operator）
-- 幂等：INSERT SELECT WHERE NOT EXISTS（name 无唯一约束，不能用 ON CONFLICT (name)）。
BEGIN;

INSERT INTO push_configs (name, cron_spec, selector_json, target_mode, target_id, preset_id, owner_wecom_id, enabled)
SELECT
  '每日经营指标日报 21:30（总经理+战区总）',
  '{"kind":"daily","time":"21:30"}'::jsonb,
  '{"kind":"role","ids":["1","2"]}'::jsonb,
  'fixed',
  823,
  'scheduled-report-card',
  'ZhangDuo',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM push_configs WHERE name = '每日经营指标日报 21:30（总经理+战区总）'
);

COMMIT;

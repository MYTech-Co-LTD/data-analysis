-- 030_branch_tasks_and_monitor.sql
-- 门店档案采集任务（3120/64188，task_type=branches）+ collect_fail 监控规则
-- 幂等：ON CONFLICT。

INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled) VALUES
 ('a0000000-0000-0000-0000-000000000004'::uuid, '乐檬-3120-门店档案采集',
  'a0000000-0000-0000-0000-000000000001'::uuid, 'collect-branches', '6 19 * * *',
  '{"task_type":"branches","company_id":3120,"page_size":200}'::jsonb, true),
 ('c0000000-0000-0000-0000-000000000004'::uuid, '乐檬-64188-门店档案采集',
  'c0000000-0000-0000-0000-000000000001'::uuid, 'collect-branches', '9 19 * * *',
  '{"task_type":"branches","company_id":64188,"page_size":200}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, schedule_cron = EXCLUDED.schedule_cron, params = EXCLUDED.params;

-- 门店采集失败告警（每日，consecutive=1）
INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled) VALUES
 ('采集失败·乐檬-3120-门店档案', 'collect_fail', 'a0000000-0000-0000-0000-000000000004',
  '{"consecutive":1,"window":5}'::jsonb, 'high', '连续 {consecutive_count} 次失败（最近 {last_status}）：{last_error}', 1800, true),
 ('采集失败·乐檬-64188-门店档案', 'collect_fail', 'c0000000-0000-0000-0000-000000000004',
  '{"consecutive":1,"window":5}'::jsonb, 'high', '连续 {consecutive_count} 次失败（最近 {last_status}）：{last_error}', 1800, true)
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  threshold = EXCLUDED.threshold, severity = EXCLUDED.severity, template = EXCLUDED.template, enabled = TRUE;

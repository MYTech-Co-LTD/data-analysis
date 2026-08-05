-- 165_collect_stall_monitor.sql
-- 采集停监控规则 seed：每 enabled 采集任务一条 collect_stall 规则（collect_tasks.last_run_at 心跳陈旧检测）。
-- 背景：锁卡住/executeTask 挂起时 collect_logs 无新行，collect_fail 抓不到 → 用 last_run_at 兜底。
-- 阈值在 evaluator（web/lib/monitor/evaluators/collect-stall.ts）内按 cron 推导：
--   分钟级任务（*/5、3-59/5、*）→ 15 分钟；日任务（0 3 * * * 等）→ 26h；
--   rule.threshold.stall_minutes 可每任务覆盖（种子默认 {} 走 cron 推导）。
-- 幂等（migrate.sh 每次部署重跑全部迁移）：动态 INSERT...SELECT，命中 023 建的唯一索引
--   uniq_monitor_rules_type_target (check_type,target) WHERE target IS NOT NULL → ON CONFLICT DO UPDATE。

INSERT INTO monitor_rules (name, check_type, target, threshold, severity, template, suppress_window_seconds, enabled)
SELECT '采集停止·' || name,
       'collect_stall',
       id::text,
       '{}'::jsonb,
       'high',
       '任务「{task_name}」采集已停止 {elapsed_minutes} 分钟（阈值 {threshold_minutes} 分钟，last_run_at={last_run_at}）',
       1800,
       true
FROM collect_tasks
WHERE enabled = true
ON CONFLICT (check_type, target) WHERE target IS NOT NULL DO UPDATE SET
  name = EXCLUDED.name,
  threshold = EXCLUDED.threshold,
  severity = EXCLUDED.severity,
  template = EXCLUDED.template,
  enabled = TRUE;

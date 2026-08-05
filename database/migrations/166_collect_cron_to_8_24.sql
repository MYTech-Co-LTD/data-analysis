-- 166_collect_cron_to_8_24.sql
-- 修复采集时间窗口：用户要求「早 8 点至 24 点」，但迁移 013 注释写 8-24、实际 SQL 是 8-23（实现与注释不一致，一直未生效）。
-- 改分钟级采集任务 cron 到 8-23,0（覆盖 8:00-23:59 每 5 分钟 + 0 点整，即「8 点至 24 点」），错峰分钟保持。
-- 幂等：WHERE 精确匹配旧 cron，重复跑无害。
UPDATE collect_tasks SET schedule_cron = '*/5 8-23,0 * * *'   WHERE schedule_cron = '*/5 8-23 * * *';
UPDATE collect_tasks SET schedule_cron = '1-59/5 8-23,0 * * *' WHERE schedule_cron = '1-59/5 8-23 * * *';
UPDATE collect_tasks SET schedule_cron = '2-59/5 8-23,0 * * *' WHERE schedule_cron = '2-59/5 8-23 * * *';
UPDATE collect_tasks SET schedule_cron = '3-59/5 8-23,0 * * *' WHERE schedule_cron = '3-59/5 8-23 * * *';
DO $$ BEGIN RAISE NOTICE 'Migration 166: 采集任务 cron 改 8-23,0（8点至24点）'; END $$;

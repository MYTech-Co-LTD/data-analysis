-- 166_collect_cron_to_8_24.sql
-- 修复采集时间窗口：用户要求「早 8 点至 24 点」，但迁移 013 注释写 8-24、实际 SQL 是 8-23（实现与注释不一致，一直未生效）。
-- 目标 cron = 8-23（8:00-23:55 每 5 分钟，覆盖 8 点至 24 点即 23:59:59 前；0 点=新一天开始，不采——避免空数据 QA 误报）。
-- 幂等：把任何 8-23,0（含 0 点）去 0 改回 8-23，重复跑无害。
UPDATE collect_tasks SET schedule_cron = replace(schedule_cron, '8-23,0', '8-23') WHERE schedule_cron LIKE '%8-23,0%';
DO $$ BEGIN RAISE NOTICE 'Migration 166: 采集任务 cron 确保 8-23（8点至24点，0点不采）'; END $$;

-- 069_collect_window_reconcile.sql
-- 采集窗口 8:00-23:59（去掉 0 点，避免凌晨对账在 API 未稳定时假通过）
-- 首次运行（08:0x）触发"前一日对账"（API 此时稳定），漏的数据会被 full 补采
-- 保持 4 任务错开防并发
-- 幂等: UPDATE

UPDATE collect_tasks SET schedule_cron = '*/5 8-23 * * *' WHERE name = '乐檬-3120-销售订单明细采集';
UPDATE collect_tasks SET schedule_cron = '3-59/5 8-23 * * *' WHERE name = '乐檬-64188-销售订单明细采集';
UPDATE collect_tasks SET schedule_cron = '1-59/5 8-23 * * *' WHERE name = '乐檬-3120-配送调出明细采集';
UPDATE collect_tasks SET schedule_cron = '2-59/5 8-23 * * *' WHERE name = '乐檬-3120-批发销售明细采集';

DO $$ BEGIN RAISE NOTICE 'Migration 069_collect_window_reconcile completed (去掉凌晨0点，首次运行在8点触发前一日对账)'; END $$;

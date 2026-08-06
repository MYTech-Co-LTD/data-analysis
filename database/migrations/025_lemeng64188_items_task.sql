-- 025_lemeng64188_items_task.sql
-- 64188 商品档案采集任务。branch_id=21170 来自 64188 token 的 JWT claim（同 3120 的 28444 来自其 token）。
-- 幂等：ON CONFLICT DO UPDATE。

INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled)
VALUES (
    'c0000000-0000-0000-0000-000000000003'::uuid,
    '乐檬-64188-商品档案采集',
    'c0000000-0000-0000-0000-000000000001'::uuid,
    'collect-items',
    '3 19 * * *',                                   -- 每天 19:03（与 3120 商品档案 19:00 错峰 3 分钟）
    '{"task_type":"items","page_size":200,"branch_id":21170}'::jsonb,
    true
) ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    schedule_cron = EXCLUDED.schedule_cron,
    params = EXCLUDED.params;

-- 64188 数据源 auth_config 补 branch_id（统一来源记录）
UPDATE data_sources
SET auth_config = '{"branch_id": 21170, "branch_nums": "99"}'::jsonb,
    updated_at = NOW()
WHERE id = 'c0000000-0000-0000-0000-000000000001';

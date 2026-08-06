-- 011_lemeng_items.sql
-- 乐檬商品档案表（商品基础信息）

CREATE TABLE IF NOT EXISTS lemeng_items (
    item_num TEXT PRIMARY KEY,                   -- 商品编号（主键）- TEXT 无长度限制
    item_code TEXT,                              -- 商品编码
    item_name TEXT,                              -- 商品名称
    item_category TEXT,                          -- 商品类别
    item_spec TEXT,                              -- 规格
    item_unit TEXT,                              -- 单位
    department TEXT,                             -- 所属部门
    item_regular_price DECIMAL(10,2),            -- 标准售价
    item_cost_price DECIMAL(10,2),               -- 成本价
    item_status TEXT,                            -- 商品状态
    branch_id INTEGER,                           -- 门店ID
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 创建索引（常用查询）
CREATE INDEX IF NOT EXISTS idx_lemeng_items_category ON lemeng_items(item_category);
CREATE INDEX IF NOT EXISTS idx_lemeng_items_department ON lemeng_items(department);
CREATE INDEX IF NOT EXISTS idx_lemeng_items_code ON lemeng_items(item_code);

COMMENT ON TABLE lemeng_items IS '乐檬商品档案（从 nhsoft.base.business.item.page.new 采集）';

-- 权限
GRANT SELECT ON lemeng_items TO authenticated;

-- 更新触发器（幂等：先删后建）
DROP TRIGGER IF EXISTS update_lemeng_items_updated_at ON lemeng_items;
CREATE TRIGGER update_lemeng_items_updated_at
    BEFORE UPDATE ON lemeng_items
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 数据源配置（商品档案）
INSERT INTO data_sources (id, name, api_endpoint, auth_type, auth_config, enabled)
VALUES (
    'a0000000-0000-0000-0000-000000000001'::uuid,
    '乐檬商品档案',
    '/earth-gateway/amazon-base/nhsoft.base.business.item.page.new',
    'bearer',
    '{"branch_id": 28444, "branch_nums": "99"}'::jsonb,
    true
) ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    api_endpoint = EXCLUDED.api_endpoint,
    auth_config = EXCLUDED.auth_config;

-- 采集任务配置（每天 19:00）
INSERT INTO collect_tasks (id, name, source_id, function_slug, schedule_cron, params, enabled)
VALUES (
    'a0000000-0000-0000-0000-000000000002'::uuid,
    '乐檬商品档案采集',
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'collect-items',
    '0 19 * * *',
    '{"task_type": "items", "page_size": 200, "branch_id": 28444}'::jsonb,
    true
) ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    schedule_cron = EXCLUDED.schedule_cron,
    params = EXCLUDED.params;
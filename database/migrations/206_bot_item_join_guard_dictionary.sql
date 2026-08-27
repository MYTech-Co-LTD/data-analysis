-- 206_bot_item_join_guard_dictionary.sql
-- 背景：2026-08-27 小海单品报表全量×2 事故——bot 生成的 SQL 用裸 item_name join dim_item
--（dim_item 双账套表：12,209 商品名中 6,056 个在 3120/64188 同名不同货）→ 整表精确 ×2
--（毛利 9,736.11 → 19,472.22 分毫实证）。收尾动作：
--   ① outbound_detail 注册行纠正：source 指向的 s3://lemeng/outbound_detail/* 是不存在的死路径，
--     该数据集实际由 agent-query 网关运行时构建（transfer_detail ∪ wholesale_detail 实时合并）。
--   ② outbound_detail 补商品键列 item_num / pos_item_code（网关视图已同步暴露；生产 parquet
--     已 DESCRIBE 验证 transfer/wholesale 明细两列俱在）——让模型"想正确 join"有键可用。
--   ③ 纠正反向诱导提示：item_name.join_to='dim_item.pos_item_name' 会鼓励裸名 join，改空并警示。
--   ④ delivery_detail / wholesale_detail 登记为 exposed 但网关从未构建这两个权限视图，
--     查询必被白名单拒（forbidden_table）→ 字典先下架，统一引导走 outbound_detail。
-- 幂等：UPDATE 条件化防重复拼接；INSERT 用 WHERE NOT EXISTS（205 同款）。
BEGIN;

-- ① 注册行纠偏（幂等覆写）
UPDATE datasets SET source = 'gateway-runtime://outbound_detail.union(transfer_detail,wholesale_detail)'
WHERE name = 'outbound_detail';

-- ② 补列（幂等）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.description, v.ordinal
FROM (VALUES
  ('outbound_detail','item_num','TEXT','商品',FALSE,'dim_item(system_book_code,item_num)',
   '乐檬账套内商品编号（跨账套会重号）。与 dim_item 关联必须配 system_book_code 复合成键，禁止单独作 join 键',9),
  ('outbound_detail','pos_item_code','TEXT','商品',FALSE,'canonical_product(item_code)',
   '货来源编码（跨账套全局唯一）。可单独作键关联 dim_item.item_code',10)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM dataset_columns WHERE dataset_name='outbound_detail' AND name=v.name
);

-- ③ 裸名 join 反向诱导纠偏（幂等：条件命中即一次性改掉）
UPDATE dataset_columns
SET join_to = NULL,
    description = '商品展示名。⚠双账套同名商品约6056组——禁止用 item_name 做 join 键（整表×2）；join 一律 sbc+item_num 复合或 pos_item_code/item_code'
WHERE dataset_name = 'outbound_detail' AND name = 'item_name'
  AND join_to = 'dim_item.pos_item_name';

-- ④ 未构建视图的数据集下架（防字典误导模型误试后被白名单拒再自由发挥；幂等：仅 exposed=TRUE 时动）
UPDATE datasets
SET exposed = FALSE,
    description = COALESCE(description,'') || '（2026-08-27 注：网关未建此数据集运行时视图，暂不可查；出库/配送/批发明细统一走 outbound_detail 合并视图）'
WHERE name IN ('delivery_detail','wholesale_detail')
  AND exposed = TRUE;

COMMIT;

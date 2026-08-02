-- 151_dim_item_item_num_index.sql
-- 给 dim_item(item_num) 建索引，加速 report_item_breakdown_gen 的 lateral_pick LATERAL join。
-- 背景：lateral_pick 的 dim join 是 JOIN LATERAL (SELECT * FROM dim_item WHERE item_num=s.item_num ORDER BY (system_book_code=s.system_book_code) DESC LIMIT 1)。
--   dim_item PK 是 (system_book_code, item_num) 复合（前导列 system_book_code），LATERAL 的 WHERE 只用 item_num 用不上 PK → 逐行 seq scan → 视图全量查询超时（>30s）。
--   加 item_num 单列索引后 LATERAL 走索引，视图查询 127ms。
-- 幂等：CREATE INDEX IF NOT EXISTS。
CREATE INDEX IF NOT EXISTS idx_dim_item_item_num ON dim_item (item_num);
DO $$ BEGIN RAISE NOTICE 'Migration 151: dim_item(item_num) 索引（加速 lateral_pick LATERAL join）'; END $$;

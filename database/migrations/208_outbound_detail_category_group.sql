-- 208_outbound_detail_category_group.sql
-- outbound_detail 增补 category_group（三类：水果/标品/耗材）列登记。
-- 数据源 = dim_item.category_group 预物化列（dim 导出侧已按 067_category_three_class 语义物化：
-- 生鲜→水果 / 标品+废弃档案+广西柳州→标品 / 包装耗材+运费仓储→耗材），视图内联注入，
-- 与报表中心（daily_delivery/daily_wholesale 模板）单一语义、零逻辑重复。
-- 8/28 生产实证：8/26+8/27 两日合计与乐檬单品综合毛利页分毫一致（232,543.95）。
BEGIN;

INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.description, v.ordinal
FROM (VALUES
  ('outbound_detail','category_group','TEXT','商品',FALSE,NULL,
   '三类归类：水果/标品/耗材（dim_item.category_group 预物化，067 语义，与报表中心同源）。业务品类聚合首选键，免 join；明细L1 细分另见 top_category',14)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM dataset_columns WHERE dataset_name='outbound_detail' AND name=v.name
);

UPDATE dataset_columns
SET description = '明细L1 归类（BP|标品/PK|包装耗材/PK41|运费/仓储用耗材/SX|生鲜/99999|废弃档案），视图内联注入。业务聚合请优先用 category_group（水果/标品/耗材，报表中心同源）'
WHERE dataset_name = 'outbound_detail' AND name = 'top_category';

UPDATE datasets
SET description = description || '；category_group=三类归类（水果/标品/耗材，与报表中心 067 同源，品类聚合首选）'
WHERE name = 'outbound_detail';

COMMIT;

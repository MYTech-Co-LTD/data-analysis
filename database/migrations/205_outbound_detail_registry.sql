-- 205_outbound_detail_registry.sql
-- spec: docs/superpowers/specs/2026-08-20-outbound-detail-merge.md
-- 注册 outbound_detail（出库明细合并视图）到数据字典（问数 list_datasets 可见）。
-- outbound_detail = delivery_detail(熊喵自营配送) ∪ wholesale_detail(品品甜经熊喵供应链批发)，
--   由 agent-query 网关按查询构建（查询时实时合并 + 权限沙箱 + 毛利脱敏），此处仅登记字典元数据。
-- 幂等：ON CONFLICT DO NOTHING（数据集行 + 列描述）。
BEGIN;

-- 数据集行
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
VALUES (
  'outbound_detail',
  '出库明细(配送∪批发)',
  'duckdb_view',
  's3://lemeng-datasource/lemeng/outbound_detail/*',
  'fact',
  TRUE, TRUE, 'biz_date', 'YYYY-MM-DD', FALSE, TRUE,
  '出库明细合并视图：熊喵自营配送(delivery_detail) ∪ 品品甜经熊喵供应链批发(wholesale_detail，client_name→64188门店映射)；含 biz_type/branch_num/amount/毛利profit(按权限脱敏)/品类；门店行级按权限裁剪'
)
ON CONFLICT (name) DO NOTHING;

-- 列描述
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.description, v.ordinal
FROM (VALUES
  ('outbound_detail','biz_type','TEXT','维度',FALSE,NULL,'业务类型：delivery=熊喵自营配送 / wholesale=品品甜经供应链批发',1),
  ('outbound_detail','sbc','TEXT','维度',FALSE,'dim_branch.system_book_code','品牌账套：3120=熊喵 / 64188=品品甜(wholesale映射后)',2),
  ('outbound_detail','branch_num','TEXT','维度',FALSE,'dim_branch.branch_num','门店号（delivery=response_branch_num；wholesale=client映射64188店号；外部客户=99）',3),
  ('outbound_detail','biz_date','TEXT','日期',FALSE,NULL,'业务日 YYYY-MM-DD（按日过滤用）',4),
  ('outbound_detail','amount','DOUBLE','金额',FALSE,NULL,'出库金额（delivery=out_money / wholesale=wholesale_money）',5),
  ('outbound_detail','profit','DOUBLE','金额',TRUE,NULL,'毛利（delivery=profit_money / wholesale=wholesale_profit；无权限=NULL）',6),
  ('outbound_detail','item_name','TEXT','商品',FALSE,'dim_item.pos_item_name','商品名',7),
  ('outbound_detail','category','TEXT','品类',FALSE,NULL,'品类',8)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
WHERE NOT EXISTS (SELECT 1 FROM dataset_columns WHERE dataset_name='outbound_detail' AND name=v.name);

COMMIT;

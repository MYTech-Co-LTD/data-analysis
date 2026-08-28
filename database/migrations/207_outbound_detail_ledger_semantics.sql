-- 207_outbound_detail_ledger_semantics.sql
-- 背景：2026-08-28 乐檬页 vs 小海问数 8/27 出库差 2.95万 复盘——outbound_detail 的 sbc 是
-- 【业务品牌归属】（64188=品品甜客户映射），而批发单据在 3120 账套落账、明细 item_num 全是
-- 3120 编号空间。任何「sbc=di.system_book_code AND item_num」式 join 会大面积 miss（8/27 实证
-- 325 行/96,235.51 被丢）+ 小号段撞号错配（16% 的"匹配"是配到别的商品）。
-- 网关视图已改为内联注入 ledger_sbc + top_category + item_code（LEFT JOIN dim_item ON ledger_sbc）。
-- 本迁移：字典补列 + 纠正 item_num 的账套语义提示。幂等。
BEGIN;

-- ① 新列登记（幂等）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.description, v.ordinal
FROM (VALUES
  ('outbound_detail','ledger_sbc','TEXT','维度',FALSE,NULL,
   '单据源账套（配送/批发均=3120，取自文件路径）。与 dim_item 等主数据 join 的账套键——注意 ≠ sbc（sbc 是业务品牌归属）',11),
  ('outbound_detail','top_category','TEXT','商品',FALSE,NULL,
   '三类归类（BP|标品 / PK|包装耗材 / PK41|运费/仓储用耗材 / SX|生鲜 / 99999|废弃档案），视图已内联注入——品类聚合直接 GROUP BY 此列，免 join dim_item',12),
  ('outbound_detail','item_code','TEXT','商品',FALSE,NULL,
   '档案 item_code（同码在两账套各有一行，使用时必须配 ledger_sbc）',13)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM dataset_columns WHERE dataset_name='outbound_detail' AND name=v.name
);

-- ② item_num 账套语义纠偏（无条件覆写=幂等）
UPDATE dataset_columns
SET join_to = NULL,
    description = '商品编号——源账套(3120)编号空间。批发单据虽业务归属品品甜(sbc=64188)，但单据在 3120 账套落账。与 dim_item 关联必须 ON di.system_book_code=<表>.ledger_sbc AND di.item_num=<表>.item_num；按 sbc 配对会大面积 miss+撞号错配（2026-08-28 实证）。品类聚合请直接用视图自带 top_category，免 join'
WHERE dataset_name = 'outbound_detail' AND name = 'item_num';

-- ③ pos_item_code 描述补强（同码双行陷阱）
UPDATE dataset_columns
SET description = '货来源编码。⚠dim_item 两账套存在同码双行——单独作 join 键会扇出×2，必须再配 ledger_sbc/system_book_code'
WHERE dataset_name = 'outbound_detail' AND name = 'pos_item_code';

-- ④ wholesale_detail.item_num 提示纠偏（数据集虽已下架，描述仍须正确）
UPDATE dataset_columns
SET join_to = NULL,
    description = '商品编号（3120 源账套编号空间；sbc=64188 是客户归属非档案账套）。与 dim_item 关联按源账套 3120 配对，或 pos_item_code=item_code 且配账套'
WHERE dataset_name = 'wholesale_detail' AND name = 'item_num';

-- ⑤ 注册行描述刷新
UPDATE datasets
SET description = '出库明细合并视图（网关运行时构建，无独立 S3 文件）：delivery(transfer_detail) ∪ wholesale(wholesale_detail，client_name→64188映射)，wholesale_ext=外部批发客户。列含 ledger_sbc（源账套）/top_category+item_code（主数据内联注入，品类聚合免 join）/item_num/pos_item_code（复合键）；行级权限裁剪、毛利脱敏'
WHERE name = 'outbound_detail';

COMMIT;

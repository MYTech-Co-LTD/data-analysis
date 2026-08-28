-- 209_outbound_detail_sale_date.sql
-- outbound_detail 增补 sale_date（出库日锚）列登记。
-- 背景（2026-08-28 定案）：biz_date 的 delivery 分量 = 制单日 order_time（与报表中心 067 模板同口径），
-- 而乐檬后台「单品综合毛利」按出库完成日（transfer_detail.sale_time / 批发 audit_time）记日——
-- 单日两系统存在等量反号的跨天搬运（8/26 制单 8/27 出库批 6,895.80），区间合计恒等。
-- sale_date 出现在视图后，「对齐乐檬页」按 sale_date 过滤即可，单日也可分毫对上。
BEGIN;

INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT v.dataset_name, v.name, v.data_type, v.semantic_group, v.is_sensitive, v.join_to, v.description, v.ordinal
FROM (VALUES
  ('outbound_detail','sale_date','TEXT','日期',FALSE,NULL,
   '出库完成日（delivery=transfer.sale_time；wholesale=audit_time 同 biz_date）。与乐檬后台单品综合毛利页同锚——按日对齐乐檬用此列，按制单日统计用 biz_date',15)
) AS v(dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
WHERE NOT EXISTS (
  SELECT 1 FROM dataset_columns WHERE dataset_name='outbound_detail' AND name=v.name
);

UPDATE datasets
SET description = description || '；sale_date=出库日锚（对齐乐檬页用）'
WHERE name = 'outbound_detail';

COMMIT;

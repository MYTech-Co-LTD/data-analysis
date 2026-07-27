-- 093_unify_category_group.sql
-- 统一 category_group 映射：wholesale 对齐 delivery（用户确认 3 组口径）
--   生鲜 → 水果
--   标品/废弃档案/广西柳州 → 标品
--   包装耗材/运费·仓储用耗材 → 耗材
--   ELSE → 其他（兜底，JOIN 不到 dim_item 或未列出品类）
-- delivery sql_template 已是这个映射（不改）；只改 daily_wholesale
-- ⚠️ 改后须重跑 wholesale /compute（category_group 是 conflict_key，DELETE-before-INSERT 幂等覆盖）
UPDATE report_definitions SET sql_template = $$
 SELECT
   COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/', 1)) AS system_book_code,
   substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
   COALESCE(db.branch_num, '99') AS branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果'
     WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
     WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
     ELSE '其他' END AS category_group,
   CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_money,
   CAST(SUM(CAST(wholesale_cost AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_cost,
   CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet') di ON di.system_book_code=regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1) AND di.item_num=d.item_num
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
 WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
$$ WHERE report_type='daily_wholesale';

DO $$ BEGIN RAISE NOTICE 'Migration 093: wholesale category_group 对齐 delivery（水果/标品/耗材/其他）；须重跑 /compute'; END $$;

-- 090_wholesale_cost_aggregate.sql
-- report_daily_wholesale 加 wholesale_cost 列（随时观察 money-cost=profit 差异）
-- /compute daily_wholesale sql_template 加 SUM(wholesale_cost)
-- 注意：用 $$ 完整 sql_template 覆盖（不用 replace，避免大小写 AS/as 匹配问题）
-- 幂等：ALTER IF NOT EXISTS + UPDATE sql_template（每次覆盖为含 cost 版）+ ⚠️ 部署后须 TRUNCATE + 重跑 /compute

-- 1. 加列
ALTER TABLE report_daily_wholesale ADD COLUMN IF NOT EXISTS wholesale_cost NUMERIC(14,2) DEFAULT 0;

-- 2. /compute sql_template 完整覆盖（066 原版 + wholesale_cost 行）
UPDATE report_definitions SET sql_template = $$
 SELECT
   COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/', 1)) AS system_book_code,
   substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
   COALESCE(db.branch_num, '99') AS branch_num,
   CASE split_part(coalesce(di.category_path,''), '->', 1)
     WHEN '生鲜' THEN '水果' WHEN '标品' THEN '标品耗材' WHEN '包装耗材' THEN '标品耗材' ELSE '其他' END AS category_group,
   CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_money,
   CAST(SUM(CAST(wholesale_cost AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_cost,
   CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
 FROM read_parquet('{{source_pattern}}', filename=true) d
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_item.parquet') di ON di.system_book_code=regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1) AND di.item_num=d.item_num
 LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
 WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
 GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
$$ WHERE report_type='daily_wholesale';

-- 3. field_mapping 加 wholesale_cost
UPDATE report_definitions SET field_mapping = field_mapping || '{"wholesale_cost":{"type":"DECIMAL(14,2)","pg_column":"wholesale_cost"}}'::jsonb
WHERE report_type='daily_wholesale';

-- 4. conflict_keys 不变（biz_date, system_book_code, branch_num, category_group）

-- 5. source_pattern 保持 ** glob（与 066 一致）
UPDATE report_definitions SET source_pattern = 's3://lemeng-datasource/lemeng/wholesale_detail/**/all.parquet'
WHERE report_type='daily_wholesale';

GRANT SELECT ON report_daily_wholesale TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 090: report_daily_wholesale 加 wholesale_cost + /compute 完整 sql_template 覆盖（含 cost 聚合）；⚠️ 须 TRUNCATE + 重跑 /compute'; END $$;

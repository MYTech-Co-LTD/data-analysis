-- 111_wholesale_qualify_columns.sql
-- 修 110：wholesale CTE 加 dim_branch join 后，filename/branch_num 等列在 d 与 db 间歧义
--   （DuckDB: Ambiguous reference to column "filename"）。全限定 d.* 列（对齐 daily_wholesale 写法）。
-- brand 仍按收货方 COALESCE(db.system_book_code, d.filename 路径)；branch_num 取收货门店 db.branch_num 回退 d.branch_num。
-- 幂等：ON CONFLICT DO UPDATE；部署后 restart postgrest。
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES

('item_outbound','出库商品级汇总','report_daily_item_outbound','s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet',
$SQL$
WITH delivery AS (
  SELECT regexp_extract(d.filename,'transfer_detail/([0-9]+)/',1) AS system_book_code,
    substr(d.order_time,1,4)||substr(d.order_time,6,2)||substr(d.order_time,9,2) AS biz_date_raw, d.item_num,
    CAST(SUM(CAST(d.out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_amount,
    CAST(SUM(CAST(d.profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet', filename=true) d
  WHERE substr(d.order_time,1,4)||substr(d.order_time,6,2)||substr(d.order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
),
wholesale AS (
  SELECT COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1)) AS system_book_code,
    substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) AS biz_date_raw, d.item_num,
    CAST(SUM(CAST(d.wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(d.wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet', filename=true) d
  LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
  WHERE substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
)
SELECT COALESCE(d.system_book_code,w.system_book_code) AS system_book_code,
  COALESCE(d.biz_date_raw,w.biz_date_raw) AS biz_date_raw, COALESCE(d.item_num,w.item_num) AS item_num,
  COALESCE(d.delivery_amount,0) AS delivery_amount, COALESCE(d.delivery_profit,0) AS delivery_profit,
  COALESCE(w.wholesale_amount,0) AS wholesale_amount, COALESCE(w.wholesale_profit,0) AS wholesale_profit
FROM delivery d FULL OUTER JOIN wholesale w
  ON d.system_book_code=w.system_book_code AND d.biz_date_raw=w.biz_date_raw AND d.item_num=w.item_num
ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"item_num":{"pg_column":"item_num","type":"TEXT"},"delivery_amount":{"pg_column":"delivery_amount","type":"DECIMAL(14,2)"},"delivery_profit":{"pg_column":"delivery_profit","type":"DECIMAL(14,2)"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'order_time','YYYYMMDD','["biz_date","system_book_code","item_num"]'::jsonb),

('wholesale_customer','批发客户级汇总','report_daily_wholesale_customer','s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet',
$SQL$
SELECT COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1)) AS system_book_code,
  substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) AS biz_date_raw,
  COALESCE(NULLIF(d.client_code,''), '(无码)') AS client_code,
  MAX(d.client_name) AS client_name, MAX(COALESCE(db.branch_num, d.branch_num)) AS branch_num,
  CAST(SUM(CAST(d.wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
  CAST(SUM(CAST(d.wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
FROM read_parquet('{{source_pattern}}', filename=true) d
LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
WHERE substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"client_code":{"pg_column":"client_code","type":"TEXT"},"client_name":{"pg_column":"client_name","type":"TEXT"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'audit_time','YYYYMMDD','["biz_date","system_book_code","client_code"]'::jsonb)

ON CONFLICT (report_type) DO UPDATE SET
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping,
  date_column=EXCLUDED.date_column, source_pattern=EXCLUDED.source_pattern;
DO $$ BEGIN RAISE NOTICE 'Migration 111: wholesale 模板全限定 d.* 列(修 filename/branch_num 歧义)'; END $$;

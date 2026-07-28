-- 110_wholesale_brand_recipient.sql
-- 修 item_outbound + wholesale_customer 的 wholesale 侧品牌归属：
--   旧（108/109）用发货路径 regexp_extract(wholesale_detail/([0-9]+)/) → 恒为 3120（熊喵发货），
--   漏了品品甜（64188）。改为**按收货方**：COALESCE(client_name→64188门店.brand_name, 路径)，
--   与 daily_wholesale/066 口径一致（品品甜门店作为熊喵批发收货方 → 归 64188）。
-- 仅改 sql_template（field_mapping/conflict_keys 不变）。幂等：ON CONFLICT DO UPDATE；部署后 restart postgrest。

INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES

('item_outbound','出库商品级汇总','report_daily_item_outbound','s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet',
$SQL$
WITH delivery AS (
  SELECT regexp_extract(filename,'transfer_detail/([0-9]+)/',1) AS system_book_code,
    substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) AS biz_date_raw, item_num,
    CAST(SUM(CAST(out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_amount,
    CAST(SUM(CAST(profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet', filename=true)
  WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
),
wholesale AS (
  SELECT COALESCE(db.system_book_code, regexp_extract(filename,'wholesale_detail/([0-9]+)/',1)) AS system_book_code,
    substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw, item_num,
    CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet', filename=true) d
  LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
  WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
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
SELECT COALESCE(db.system_book_code, regexp_extract(filename,'wholesale_detail/([0-9]+)/',1)) AS system_book_code,
  substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
  COALESCE(NULLIF(client_code,''), '(无码)') AS client_code,
  MAX(client_name) AS client_name, MAX(branch_num) AS branch_num,
  CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
  CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
FROM read_parquet('{{source_pattern}}', filename=true) d
LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"client_code":{"pg_column":"client_code","type":"TEXT"},"client_name":{"pg_column":"client_name","type":"TEXT"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'audit_time','YYYYMMDD','["biz_date","system_book_code","client_code"]'::jsonb)

ON CONFLICT (report_type) DO UPDATE SET
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping,
  date_column=EXCLUDED.date_column, source_pattern=EXCLUDED.source_pattern;
DO $$ BEGIN RAISE NOTICE 'Migration 110: item_outbound/wholesale_customer wholesale 侧品牌改按收货方(client→64188门店)'; END $$;

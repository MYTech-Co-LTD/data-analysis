-- 108_report_item_customer_compute_defs.sql
-- 3 个 /compute 定义：item_sales / item_outbound / wholesale_customer
-- 幂等：ON CONFLICT DO UPDATE
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES

-- item_sales：retail_detail 按 (品牌,日,商品) 聚合销售金额/利润
('item_sales','销售商品级汇总','report_daily_item_sales','s3://lemeng-datasource/lemeng/retail_detail/**/*.parquet',
$SQL$
SELECT regexp_extract(filename,'retail_detail/([0-9]+)/',1) AS system_book_code,
  order_detail_bizday AS biz_date_raw, item_num,
  CAST(SUM(CAST(sale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_amount,
  CAST(SUM(CAST(profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE order_detail_bizday BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"item_num":{"pg_column":"item_num","type":"TEXT"},"sale_amount":{"pg_column":"sale_amount","type":"DECIMAL(14,2)"},"sale_profit":{"pg_column":"sale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'order_detail_bizday','YYYYMMDD','["biz_date","system_book_code","item_num"]'::jsonb),

-- item_outbound：transfer+wholesale 双源 CTE，FULL JOIN 合并（delivery/wholesale 各列）
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
  SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
    substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw, item_num,
    CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet', filename=true)
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

-- wholesale_customer：wholesale_detail 按 (品牌,日,客户) 聚合
('wholesale_customer','批发客户级汇总','report_daily_wholesale_customer','s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet',
$SQL$
SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
  substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
  COALESCE(NULLIF(client_code,''), '(无码)'||MAX(client_name)) AS client_code,
  MAX(client_name) AS client_name, MAX(branch_num) AS branch_num,
  CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
  CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3 ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"client_code":{"pg_column":"client_code","type":"TEXT"},"client_name":{"pg_column":"client_name","type":"TEXT"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'audit_time','YYYYMMDD','["biz_date","system_book_code","client_code"]'::jsonb)

ON CONFLICT (report_type) DO UPDATE SET
  name=EXCLUDED.name, target_table=EXCLUDED.target_table, source_pattern=EXCLUDED.source_pattern,
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping,
  date_column=EXCLUDED.date_column, date_format=EXCLUDED.date_format, conflict_keys=EXCLUDED.conflict_keys, enabled=true;
DO $$ BEGIN RAISE NOTICE 'Migration 108: item_sales/item_outbound/wholesale_customer compute 定义'; END $$;

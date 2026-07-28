-- 109_fix_wholesale_customer_template.sql
-- 修 108 wholesale_customer：GROUP BY 桶表达式含 MAX(client_name) 聚合 → DuckDB binder error
--   （"Binder Error: GROUP BY clause cannot contain aggregates!"），/compute 每周期 500，表常空。
-- 改：桶用 COALESCE(NULLIF(client_code,''),'(无码)')，MAX(client_name) 作普通聚合列。
-- 幂等：ON CONFLICT(report_type) DO UPDATE；部署后须 restart postgrest 刷 schema 缓存。
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES
('wholesale_customer','批发客户级汇总','report_daily_wholesale_customer','s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet',
$SQL$
SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
  substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
  COALESCE(NULLIF(client_code,''), '(无码)') AS client_code,
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
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping;
DO $$ BEGIN RAISE NOTICE 'Migration 109: 修 wholesale_customer GROUP BY 聚合 binder error'; END $$;

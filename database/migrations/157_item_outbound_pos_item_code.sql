-- 157_item_outbound_pos_item_code.sql
-- report_daily_item_outbound 加 pos_item_code 列（货来源编码），修 outbound lateral_pick 归错：
--   110 把批发按收货方分配 sbc（64188），item_num 是发货方货号（3120）。
--   lateral_pick 本账套优先在 64188 有同名 item_num 不同商品时归错
--   （如 item_num=597：3120=红宝石柚活动果 25580、64188=云威月饼 83403，64188 批发 597 被归到云威月饼）。
--   pos_item_code 是 parquet 货来源编码（全非空，实测 wholesale 10426/10426、transfer 27161/27161），
--   视图按它 join dim_item 正确归到货来源商品。详见 architecture.md §10.10 dim_grain_override。
-- 幂等：ADD COLUMN IF NOT EXISTS；ON CONFLICT DO UPDATE；部署后 restart postgrest + 重算 report_daily_item_outbound。

ALTER TABLE report_daily_item_outbound ADD COLUMN IF NOT EXISTS pos_item_code TEXT;

-- 更新 item_outbound sql_template（delivery/wholesale CTE 加 MAX(pos_item_code)，final COALESCE）+ field_mapping
INSERT INTO report_definitions (report_type, name, target_table, source_pattern, sql_template, field_mapping, date_column, date_format, conflict_keys) VALUES
('item_outbound','出库商品级汇总','report_daily_item_outbound','s3://lemeng-datasource/lemeng/transfer_detail/**/all.parquet',
$SQL$
WITH delivery AS (
  SELECT regexp_extract(d.filename,'transfer_detail/([0-9]+)/',1) AS system_book_code,
    substr(d.order_time,1,4)||substr(d.order_time,6,2)||substr(d.order_time,9,2) AS biz_date_raw, d.item_num,
    MAX(d.pos_item_code) AS pos_item_code,
    CAST(SUM(CAST(d.out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_amount,
    CAST(SUM(CAST(d.profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/all.parquet', filename=true) d
  WHERE substr(d.order_time,1,4)||substr(d.order_time,6,2)||substr(d.order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
),
wholesale AS (
  SELECT COALESCE(db.system_book_code, regexp_extract(d.filename,'wholesale_detail/([0-9]+)/',1)) AS system_book_code,
    substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) AS biz_date_raw, d.item_num,
    MAX(d.pos_item_code) AS pos_item_code,
    CAST(SUM(CAST(d.wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(d.wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/all.parquet', filename=true) d
  LEFT JOIN read_parquet('s3://lemeng-datasource/dims/dim_branch.parquet') db ON db.system_book_code='64188' AND db.branch_name=d.client_name
  WHERE substr(d.audit_time,1,4)||substr(d.audit_time,6,2)||substr(d.audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3
)
SELECT COALESCE(d.system_book_code,w.system_book_code) AS system_book_code,
  COALESCE(d.biz_date_raw,w.biz_date_raw) AS biz_date_raw, COALESCE(d.item_num,w.item_num) AS item_num,
  COALESCE(d.pos_item_code, w.pos_item_code) AS pos_item_code,
  COALESCE(d.delivery_amount,0) AS delivery_amount, COALESCE(d.delivery_profit,0) AS delivery_profit,
  COALESCE(w.wholesale_amount,0) AS wholesale_amount, COALESCE(w.wholesale_profit,0) AS wholesale_profit
FROM delivery d FULL OUTER JOIN wholesale w
  ON d.system_book_code=w.system_book_code AND d.biz_date_raw=w.biz_date_raw AND d.item_num=w.item_num
ORDER BY 1,2,3
$SQL$,
'{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"item_num":{"pg_column":"item_num","type":"TEXT"},"pos_item_code":{"pg_column":"pos_item_code","type":"TEXT"},"delivery_amount":{"pg_column":"delivery_amount","type":"DECIMAL(14,2)"},"delivery_profit":{"pg_column":"delivery_profit","type":"DECIMAL(14,2)"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
'order_time','YYYYMMDD','["biz_date","system_book_code","item_num"]'::jsonb)
ON CONFLICT (report_type) DO UPDATE SET
  sql_template=EXCLUDED.sql_template, field_mapping=EXCLUDED.field_mapping;

DO $$ BEGIN RAISE NOTICE 'Migration 157: item_outbound 加 pos_item_code（货来源编码）修 lateral_pick 归错'; END $$;

-- 116_fix_wholesale_item_outbound_glob.sql
-- 修 item_outbound / wholesale_customer 的 source glob：**/*.parquet 同时匹配 all.parquet + 门店分片
--   （分片 branch_num_99.parquet 内容与 all.parquet 完全相同）→ 每条记录读两遍，SUM 翻倍。
--   品牌表品品甜配送因此 819万 vs 实际 ~410万（2倍）。
--   老表 daily_delivery / daily_wholesale 用 **/all.parquet（只读 all），故正确。
--   改为 **/all.parquet 与老表对齐。幂等（可重跑）；改 sql_template 后重跑 /compute 生效，无需 restart postgrest。

-- wholesale_customer：模板用 {{source_pattern}}，改 source_pattern 即可
UPDATE report_definitions
   SET source_pattern = 's3://lemeng-datasource/lemeng/wholesale_detail/**/all.parquet'
 WHERE report_type = 'wholesale_customer';

-- item_sales：同样坑（retail_detail 也是 all+分片，daily_sales 用 **/all.parquet 正确）
UPDATE report_definitions
   SET source_pattern = 's3://lemeng-datasource/lemeng/retail_detail/**/all.parquet'
 WHERE report_type = 'item_sales';

-- item_outbound：模板里硬编码了两条 read_parquet 路径，REPLACE 改 glob
UPDATE report_definitions
   SET sql_template = REPLACE(REPLACE(sql_template,
        'lemeng/transfer_detail/**/*.parquet', 'lemeng/transfer_detail/**/all.parquet'),
        'lemeng/wholesale_detail/**/*.parquet', 'lemeng/wholesale_detail/**/all.parquet'),
       source_pattern = 's3://lemeng-datasource/lemeng/transfer_detail/**/all.parquet'
 WHERE report_type = 'item_outbound';

DO $$ BEGIN RAISE NOTICE 'Migration 116: item_outbound/wholesale_customer glob 改 **/all.parquet（修 all+分片重复读致 SUM 翻倍）'; END $$;

-- 200_item_branch_grain.sql
-- spec: docs/superpowers/specs/2026-08-19-item-branch-grain.md
-- 商品粒度门店化（2026-08-19 用户裁定）：item_sales/item_outbound 重建为 branch 粒度
--   PK (biz_date, system_book_code, branch_num, item_num)，补 branch RLS；RPC 日榜/明细补 branch 过滤；
--   report_definitions compute SQL 加 branch 列。源 parquet 明细本就有门店键（107/108 建表时聚合掉了）。
-- 破坏性：DROP TABLE（CASCADE 连带 drop report_item_breakdown_gen 视图，generated 文件随后重建）。
--   回填前先备份原表（_backup_200_*，对照验证用）。
-- 幂等：以 branch_num 列存在性守卫——已迁移（含已回填数据）则整段跳过，防重复部署清数据。
BEGIN;

-- ---- 备份（对照验证；已存在则跳过） ----
CREATE TABLE IF NOT EXISTS _backup_200_item_sales AS TABLE report_daily_item_sales;
CREATE TABLE IF NOT EXISTS _backup_200_item_outbound AS TABLE report_daily_item_outbound;

-- ---- 重建 item_sales（branch 粒度） ----
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'report_daily_item_sales'::regclass AND attname = 'branch_num' AND NOT attisdropped) THEN
    RAISE NOTICE 'Migration 200: item_sales 已是 branch 粒度，跳过';
  ELSE
    DROP TABLE report_daily_item_sales CASCADE;
    CREATE TABLE report_daily_item_sales (
      biz_date DATE NOT NULL, system_book_code TEXT NOT NULL,
      branch_num TEXT NOT NULL, item_num TEXT NOT NULL,
      sale_amount DECIMAL(14,2) DEFAULT 0, sale_profit DECIMAL(14,2) DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (biz_date, system_book_code, branch_num, item_num)
    );
    CREATE INDEX idx_rdis_sbc_date ON report_daily_item_sales(system_book_code, biz_date);
    CREATE INDEX idx_rdis_branch ON report_daily_item_sales(system_book_code, branch_num, biz_date);
    ALTER TABLE report_daily_item_sales ENABLE ROW LEVEL SECURITY;
    CREATE POLICY report_rls_brand ON report_daily_item_sales FOR SELECT TO authenticated
      USING (scope_match_v2('brands', system_book_code));
    CREATE POLICY report_rls_branch_nums ON report_daily_item_sales FOR SELECT TO authenticated
      USING (scope_match_v2('branch_nums', branch_num::text)
          OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num));
    GRANT SELECT ON report_daily_item_sales TO anon, authenticated;
    RAISE NOTICE 'Migration 200: item_sales 重建为 branch 粒度（待 /compute 回填）';
  END IF;
END $do$;

-- ---- 重建 item_outbound（branch 粒度） ----
DO $do$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'report_daily_item_outbound'::regclass AND attname = 'branch_num' AND NOT attisdropped) THEN
    RAISE NOTICE 'Migration 200: item_outbound 已是 branch 粒度，跳过';
  ELSE
    DROP TABLE report_daily_item_outbound CASCADE;
    CREATE TABLE report_daily_item_outbound (
      biz_date DATE NOT NULL, system_book_code TEXT NOT NULL,
      branch_num TEXT NOT NULL, item_num TEXT NOT NULL,
      delivery_amount DECIMAL(14,2) DEFAULT 0, delivery_profit DECIMAL(14,2) DEFAULT 0,
      wholesale_amount DECIMAL(14,2) DEFAULT 0, wholesale_profit DECIMAL(14,2) DEFAULT 0,
      pos_item_code TEXT,
      updated_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (biz_date, system_book_code, branch_num, item_num)
    );
    CREATE INDEX idx_rdio_sbc_date ON report_daily_item_outbound(system_book_code, biz_date);
    CREATE INDEX idx_rdio_branch ON report_daily_item_outbound(system_book_code, branch_num, biz_date);
    ALTER TABLE report_daily_item_outbound ENABLE ROW LEVEL SECURITY;
    CREATE POLICY report_rls_brand ON report_daily_item_outbound FOR SELECT TO authenticated
      USING (scope_match_v2('brands', system_book_code));
    CREATE POLICY report_rls_branch_nums ON report_daily_item_outbound FOR SELECT TO authenticated
      USING (scope_match_v2('branch_nums', branch_num::text)
          OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num));
    GRANT SELECT ON report_daily_item_outbound TO anon, authenticated;
    RAISE NOTICE 'Migration 200: item_outbound 重建为 branch 粒度（待 /compute 回填）';
  END IF;
END $do$;

-- ---- RPC：日榜补 branch 过滤（SECURITY DEFINER 旁路 RLS，沿用 198 brands 同款） ----
CREATE OR REPLACE FUNCTION public.get_item_top_by_day(p_target_id bigint, p_day date)
RETURNS TABLE(item_code text, item_name text, category_name text, sale_amount numeric, sale_profit numeric, outbound_amount numeric, outbound_profit numeric)
LANGUAGE sql SECURITY DEFINER AS $fn$
  WITH sale AS (
    SELECT di.item_code,
      MAX(di.item_name) AS item_name, MAX(di.category_name) AS category_name,
      SUM(s.sale_amount) AS sale_amount,
      SUM(s.sale_profit) AS sale_profit
    FROM report_daily_item_sales s
    JOIN LATERAL (SELECT * FROM dim_item WHERE item_num = s.item_num ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
    WHERE s.biz_date = p_day
      AND scope_match_v2('brands', s.system_book_code)
      AND (scope_match_v2('branch_nums', s.branch_num::text)
        OR scope_match_v2('branch_nums', s.system_book_code || '-' || s.branch_num))
      AND EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id AND p_day BETWEEN t.start_date AND t.end_date)
    GROUP BY di.item_code
  ),
  outbound AS (
    SELECT di.item_code,
      MAX(di.item_name) AS item_name, MAX(di.category_name) AS category_name,
      SUM(s.delivery_amount) AS delivery_amount, SUM(s.wholesale_amount) AS wholesale_amount,
      SUM(s.delivery_profit) AS delivery_profit, SUM(s.wholesale_profit) AS wholesale_profit
    FROM report_daily_item_outbound s
    JOIN LATERAL (SELECT * FROM dim_item WHERE item_code = s.pos_item_code ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
    WHERE s.biz_date = p_day
      AND scope_match_v2('brands', s.system_book_code)
      AND (scope_match_v2('branch_nums', s.branch_num::text)
        OR scope_match_v2('branch_nums', s.system_book_code || '-' || s.branch_num))
      AND EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id AND p_day BETWEEN t.start_date AND t.end_date)
    GROUP BY di.item_code
  )
  SELECT COALESCE(s.item_code, o.item_code) AS item_code,
    COALESCE(s.item_name, o.item_name) AS item_name,
    COALESCE(s.category_name, o.category_name) AS category_name,
    COALESCE(s.sale_amount, 0) AS sale_amount,
    CASE WHEN can_cost_visible() THEN COALESCE(s.sale_profit, 0) END AS sale_profit,
    COALESCE(o.delivery_amount, 0) + COALESCE(o.wholesale_amount, 0) AS outbound_amount,
    CASE WHEN can_cost_visible() THEN COALESCE(o.delivery_profit, 0) + COALESCE(o.wholesale_profit, 0) END AS outbound_profit
  FROM sale s
  FULL OUTER JOIN outbound o ON o.item_code = s.item_code;
$fn$;

-- ---- RPC：出库明细（get_item_detail）补 branch 过滤 ----
CREATE OR REPLACE FUNCTION public.get_item_detail(p_target_id bigint, p_item_code text)
RETURNS TABLE(biz_date date, system_book_code text, sale_amount numeric, outbound_amount numeric)
LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT s.biz_date, s.system_book_code,
    COALESCE(SUM(s.sale_amount), 0) AS sale_amount,
    COALESCE(SUM(o.delivery_amount), 0) + COALESCE(SUM(o.wholesale_amount), 0) AS outbound_amount
  FROM targets t
  JOIN report_daily_item_sales s ON s.biz_date BETWEEN t.start_date AND t.end_date
    AND scope_match_v2('brands', s.system_book_code)
    AND (scope_match_v2('branch_nums', s.branch_num::text)
      OR scope_match_v2('branch_nums', s.system_book_code || '-' || s.branch_num))
  JOIN dim_item di ON di.system_book_code = s.system_book_code
                   AND di.item_num = s.item_num
                   AND di.item_code = p_item_code
  LEFT JOIN report_daily_item_outbound o ON o.biz_date = s.biz_date
                    AND o.system_book_code = s.system_book_code
                    AND o.item_num = s.item_num
  WHERE t.id = p_target_id
  GROUP BY s.biz_date, s.system_book_code
  ORDER BY s.biz_date;
$fn$;

-- ---- compute 定义：item_sales 加 branch_num（retail_detail.branch_num） ----
UPDATE report_definitions SET
  sql_template = $SQL$
SELECT regexp_extract(filename,'retail_detail/([0-9]+)/',1) AS system_book_code,
  order_detail_bizday AS biz_date_raw, branch_num, item_num,
  CAST(SUM(CAST(sale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_amount,
  CAST(SUM(CAST(profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS sale_profit
FROM read_parquet('{{source_pattern}}', filename=true)
WHERE order_detail_bizday BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
$SQL$,
  field_mapping = '{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"item_num":{"pg_column":"item_num","type":"TEXT"},"sale_amount":{"pg_column":"sale_amount","type":"DECIMAL(14,2)"},"sale_profit":{"pg_column":"sale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
  conflict_keys = '["biz_date","system_book_code","branch_num","item_num"]'::jsonb
WHERE report_type = 'item_sales';

-- ---- compute 定义：item_outbound 加 branch_num（delivery=response_branch_num / wholesale=branch_num） ----
UPDATE report_definitions SET
  sql_template = $SQL$
WITH delivery AS (
  SELECT regexp_extract(filename,'transfer_detail/([0-9]+)/',1) AS system_book_code,
    substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) AS biz_date_raw,
    response_branch_num AS branch_num, item_num, pos_item_code,
    CAST(SUM(CAST(out_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_amount,
    CAST(SUM(CAST(profit_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS delivery_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/transfer_detail/**/*.parquet', filename=true)
  WHERE substr(order_time,1,4)||substr(order_time,6,2)||substr(order_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3,4,5
),
wholesale AS (
  SELECT regexp_extract(filename,'wholesale_detail/([0-9]+)/',1) AS system_book_code,
    substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) AS biz_date_raw,
    branch_num, item_num, pos_item_code,
    CAST(SUM(CAST(wholesale_money AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_amount,
    CAST(SUM(CAST(wholesale_profit AS DECIMAL(14,2))) AS DECIMAL(14,2)) AS wholesale_profit
  FROM read_parquet('s3://lemeng-datasource/lemeng/wholesale_detail/**/*.parquet', filename=true)
  WHERE substr(audit_time,1,4)||substr(audit_time,6,2)||substr(audit_time,9,2) BETWEEN '{{date_from_compact}}' AND '{{date_to_compact}}'
  GROUP BY 1,2,3,4,5
)
SELECT COALESCE(d.system_book_code, w.system_book_code) AS system_book_code,
  COALESCE(d.biz_date_raw, w.biz_date_raw) AS biz_date_raw,
  COALESCE(d.branch_num, w.branch_num) AS branch_num,
  COALESCE(d.item_num, w.item_num) AS item_num,
  COALESCE(d.pos_item_code, w.pos_item_code) AS pos_item_code,
  CAST(COALESCE(d.delivery_amount, 0) AS DECIMAL(14,2)) AS delivery_amount,
  CAST(COALESCE(d.delivery_profit, 0) AS DECIMAL(14,2)) AS delivery_profit,
  CAST(COALESCE(w.wholesale_amount, 0) AS DECIMAL(14,2)) AS wholesale_amount,
  CAST(COALESCE(w.wholesale_profit, 0) AS DECIMAL(14,2)) AS wholesale_profit
FROM delivery d
FULL OUTER JOIN wholesale w ON w.system_book_code = d.system_book_code
  AND w.biz_date_raw = d.biz_date_raw AND w.branch_num = d.branch_num AND w.item_num = d.item_num
$SQL$,
  field_mapping = '{"system_book_code":{"pg_column":"system_book_code","type":"TEXT"},"biz_date_raw":{"pg_column":"biz_date","transform":"YYYYMMDD_to_YYYY-MM-DD"},"branch_num":{"pg_column":"branch_num","type":"TEXT"},"item_num":{"pg_column":"item_num","type":"TEXT"},"pos_item_code":{"pg_column":"pos_item_code","type":"TEXT"},"delivery_amount":{"pg_column":"delivery_amount","type":"DECIMAL(14,2)"},"delivery_profit":{"pg_column":"delivery_profit","type":"DECIMAL(14,2)"},"wholesale_amount":{"pg_column":"wholesale_amount","type":"DECIMAL(14,2)"},"wholesale_profit":{"pg_column":"wholesale_profit","type":"DECIMAL(14,2)"}}'::jsonb,
  conflict_keys = '["biz_date","system_book_code","branch_num","item_num"]'::jsonb
WHERE report_type = 'item_outbound';

-- ---- 验证断言 ----
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'report_daily_item_sales'::regclass AND attname = 'branch_num' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Migration 200: item_sales 缺 branch_num 列';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'report_daily_item_outbound'::regclass AND attname = 'branch_num' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Migration 200: item_outbound 缺 branch_num 列';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'report_daily_item_sales'::regclass AND polname = 'report_rls_branch_nums') = 0 THEN
    RAISE EXCEPTION 'Migration 200: item_sales 缺 branch RLS 策略';
  END IF;
  RAISE NOTICE 'Migration 200: 完成（item 表 branch 粒度 + RLS + RPC 过滤 + compute 定义）';
END $do$;

COMMIT;

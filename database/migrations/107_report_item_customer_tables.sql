-- 107_report_item_customer_tables.sql
-- 报表 Phase 2 数据层：商品/客户级聚合表（解锁品牌表品品甜配送 + 商品TOP20 + 批发客户下钻）
-- 粒度 (biz_date, system_book_code, item_num/client_code)；brand 从 parquet 路径取，/compute 聚合写入
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT + DROP/CREATE POLICY；部署后 restart postgrest

-- 1. 销售商品级
CREATE TABLE IF NOT EXISTS report_daily_item_sales (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, item_num TEXT NOT NULL,
  sale_amount DECIMAL(14,2) DEFAULT 0, sale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
-- 2. 出库商品级（delivery+wholesale 合表）
CREATE TABLE IF NOT EXISTS report_daily_item_outbound (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, item_num TEXT NOT NULL,
  delivery_amount DECIMAL(14,2) DEFAULT 0, delivery_profit DECIMAL(14,2) DEFAULT 0,
  wholesale_amount DECIMAL(14,2) DEFAULT 0, wholesale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, item_num)
);
-- 3. 批发客户级
CREATE TABLE IF NOT EXISTS report_daily_wholesale_customer (
  biz_date DATE NOT NULL, system_book_code TEXT NOT NULL, client_code TEXT NOT NULL,
  client_name TEXT, branch_num TEXT,
  wholesale_amount DECIMAL(14,2) DEFAULT 0, wholesale_profit DECIMAL(14,2) DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (biz_date, system_book_code, client_code)
);
CREATE INDEX IF NOT EXISTS idx_rdis_sbc_date ON report_daily_item_sales(system_book_code, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdio_sbc_date ON report_daily_item_outbound(system_book_code, biz_date);
CREATE INDEX IF NOT EXISTS idx_rdwc_sbc_date ON report_daily_wholesale_customer(system_book_code, biz_date);

-- 品牌 RLS（claim branch_nums=['*']或NULL→全量；否则限用户门店所属品牌）。照 report_daily_delivery 模式派生品牌。
-- item_sales
DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_sales;
CREATE POLICY report_rls_brand ON report_daily_item_sales FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
-- item_outbound（同上 policy）
DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_outbound;
CREATE POLICY report_rls_brand ON report_daily_item_outbound FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
-- wholesale_customer（同上 policy）
DROP POLICY IF EXISTS report_rls_brand ON report_daily_wholesale_customer;
CREATE POLICY report_rls_brand ON report_daily_wholesale_customer FOR SELECT TO authenticated USING (
  current_setting('request.jwt.claims.branch_nums', true) IS NULL
  OR (current_setting('request.jwt.claims.branch_nums', true))::jsonb ? '*'
  OR system_book_code IN (
    SELECT DISTINCT d.system_book_code FROM dim_branch d
    WHERE d.branch_num = ANY(SELECT jsonb_array_elements_text((current_setting('request.jwt.claims.branch_nums', true))::jsonb))
  )
);
-- 启用 RLS（CREATE POLICY 不自动 enable；照 015/058 模式显式开启，否则 policy 不生效）
ALTER TABLE report_daily_item_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_daily_item_outbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_daily_wholesale_customer ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON report_daily_item_sales, report_daily_item_outbound, report_daily_wholesale_customer TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 107: item/customer 聚合表 3 张 + 品牌 RLS'; END $$;

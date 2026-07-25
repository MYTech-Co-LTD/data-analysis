-- 084_dim_brand.sql
-- 品牌维表：system_book_code → 品牌名 单一事实源（替代前端/文档硬编码）
-- 复用点：前端品牌下拉、报表表头、collect_tasks/data_sources 关联、文档
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；部署后重启 postgrest

CREATE TABLE IF NOT EXISTS dim_brand (
  system_book_code TEXT PRIMARY KEY,    -- '3120' / '64188'
  brand_name       TEXT NOT NULL,       -- 熊喵鲜生 / 品品甜
  short_name       TEXT,                -- 简称
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE dim_brand IS '品牌编码→品牌名映射（单一事实源；前端/报表/文档复用）';

INSERT INTO dim_brand (system_book_code, brand_name, short_name) VALUES
  ('3120', '熊喵鲜生', '熊喵'),
  ('64188', '品品甜', '品品')
ON CONFLICT (system_book_code) DO UPDATE SET
  brand_name = EXCLUDED.brand_name,
  short_name = EXCLUDED.short_name,
  updated_at = NOW();

-- datasets 注册（carry-dims 自动 COPY 到 parquet；前端/duckdb 可读）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, carry_enabled, exposed, description) VALUES
 ('dim_brand', '品牌维度', 'pg_table', 'dim_brand', 'dim', FALSE, FALSE, NULL, TRUE, TRUE,
  '品牌编码→品牌名映射（3120=熊喵鲜生 / 64188=品品甜）；品牌下拉/表头复用')
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name, engine = EXCLUDED.engine, source = EXCLUDED.source,
  kind = EXCLUDED.kind, carry_enabled = EXCLUDED.carry_enabled, exposed = EXCLUDED.exposed,
  description = EXCLUDED.description;

GRANT SELECT ON dim_brand TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 084_dim_brand completed: 3120=熊喵鲜生, 64188=品品甜'; END $$;

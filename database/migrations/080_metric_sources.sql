-- 080_metric_sources.sql
-- 指标→聚合表数据源映射（生成器实际 FROM 的表）
-- 与 metric_registry 口径声明解耦：换数据源不动口径
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；部署后重启 postgrest

CREATE TABLE IF NOT EXISTS metric_sources (
  metric_code   TEXT PRIMARY KEY REFERENCES metric_registry(metric_code) ON DELETE CASCADE,
  source_table  TEXT NOT NULL,        -- 聚合 PG 表（report_daily_sales 等）
  source_column TEXT,                 -- base: 聚合列；derived: NULL
  source_filter TEXT,                 -- 可选过滤（一般留 NULL：指标品牌无关，品牌由 target_scoped 按 target 限；勿硬编码品牌）
  note          TEXT
);

COMMENT ON TABLE metric_sources IS '指标数据源映射：生成器读此表定位聚合 PG 表+列';

INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note) VALUES
  ('sale_amount','report_daily_sales','total_sale',NULL,NULL),
  ('sale_profit','report_daily_sales','total_profit',NULL,'成本敏感'),
  ('delivery_amount','report_daily_delivery','out_money',NULL,NULL),
  ('delivery_profit','report_daily_delivery','profit_money',NULL,'成本敏感'),
  ('wholesale_amount','report_daily_wholesale','wholesale_money',NULL,NULL),
  ('wholesale_profit','report_daily_wholesale','wholesale_profit',NULL,'成本敏感'),
  ('outbound_amount','report_daily_delivery',NULL,NULL,'derived: 生成器按 formula 合并 delivery+wholesale（多源，后续）'),
  ('outbound_profit','report_daily_delivery',NULL,NULL,'derived: 同上（多源，后续）'),
  ('margin','report_daily_sales',NULL,NULL,'derived: 生成器重算 profit/amount（同源）')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

GRANT SELECT ON metric_sources TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 080 completed: metric_sources + 9 mappings'; END $$;

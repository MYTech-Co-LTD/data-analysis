-- 124_fix_wholesale_pp_source.sql
-- 修正 wholesale_pp 的 metric_sources：088 指向 report_daily_wholesale.wholesale_money，
-- 但 112/113 品牌视图 + 091 outbound_drill 实际用 report_daily_wholesale_customer.wholesale_amount。
-- 两表列名也不同（wholesale_money vs wholesale_amount）。
-- 修正：wholesale_pp 改指向 report_daily_wholesale_customer.wholesale_amount（与品牌视图一致）。
-- 幂等：ON CONFLICT DO UPDATE；部署后 restart postgrest。

-- 先删旧的 wholesale_pp source（指向 report_daily_wholesale 的）
DELETE FROM metric_sources WHERE metric_code IN ('wholesale_pp_amount','wholesale_pp_profit');

INSERT INTO metric_sources (metric_code, source_table, source_column, source_filter, note)
VALUES
  ('wholesale_pp_amount','report_daily_wholesale_customer','wholesale_amount','s.system_book_code = ''64188''','品品甜门店（brand 视图 112/113 用此表；customer 粒度）'),
  ('wholesale_pp_profit','report_daily_wholesale_customer','wholesale_profit','s.system_book_code = ''64188''','品品甜门店，成本敏感')
ON CONFLICT (metric_code) DO UPDATE SET
  source_table=EXCLUDED.source_table, source_column=EXCLUDED.source_column,
  source_filter=EXCLUDED.source_filter, note=EXCLUDED.note;

DO $$ BEGIN RAISE NOTICE 'Migration 124: wholesale_pp source → report_daily_wholesale_customer'; END $$;

-- 126_drop_old_brand_metric_v.sql
-- P1 收口：下线旧手写品牌表视图，前端已切 report_brand_metric_gen（生成器产物）。
-- 前提（均已满足）：
--   - L3b 双轨 diff=0（sale_target/sale_amount/sale_rate/delivery_amount/delivery_profit/delivery_margin 全列逐字一致）
--   - 前端 web/lib/report-center/brand-metric.ts 已 .from('report_brand_metric_gen')
--   - 无其他视图/函数/前端引用 report_brand_metric_v（pg_depend 0 行）
-- 幂等：DROP VIEW IF EXISTS；部署后 restart postgrest 刷 schema 缓存。
DROP VIEW IF EXISTS report_brand_metric_v;
DO $$ BEGIN RAISE NOTICE 'Migration 126: 下线 report_brand_metric_v（P1 品牌表迁移收口，由 report_brand_metric_gen 取代）'; END $$;

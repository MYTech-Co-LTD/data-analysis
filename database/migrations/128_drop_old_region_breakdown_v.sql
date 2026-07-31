-- 128_drop_old_region_breakdown_v.sql
-- P2 收口：下线旧手写下钻视图，前端已切 report_region_breakdown_gen（层级生成器产物）。
-- 前提（均已满足）：
--   - L3b 双轨 diff=0（store/region/sub_region 各列 SUM 全 0.00 vs 120，行数 4/14/244 一致，rate/remaining 对齐）
--   - 前端 web/lib/report-center/region-breakdown.ts 已 .from('report_region_breakdown_gen')
--   - 无其它视图/函数/前端引用（pg_depend 0 行）
-- 幂等：DROP VIEW IF EXISTS；部署后 restart postgrest 刷 schema 缓存。
DROP VIEW IF EXISTS report_region_breakdown_v;
DO $$ BEGIN RAISE NOTICE 'Migration 128: 下线 report_region_breakdown_v（P2 下钻表迁移收口，由 report_region_breakdown_gen 取代）'; END $$;

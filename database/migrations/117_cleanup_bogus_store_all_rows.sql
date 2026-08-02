-- 117_cleanup_bogus_store_all_rows.sql
-- 清脏数据：store 级目标里 branch_num='ALL' 的假行（store 级应是真实门店号）。
--   历史残留（早期 upsert/导入误写），3 行(id 285/286/287, parent=22)。
--   war_zone/region_l2 级用 branch_num='ALL' 是正常的（聚合行），不动；只清 breakdown_level='store' 的。
--   这些假行被所有查询用 branch_num<>'ALL' 或 dim_branch join 自然过滤，无害但脏，清掉。
--   幂等：纯 DELETE，重跑 no-op。
-- ⚠️ 2026-08-02 加 target_type='store' 守卫：hq 品类目标(upsert_hq_category_breakdown 创建)因
--   targets.breakdown_level DEFAULT 'store' 被误填成 'store'，本迁移每次部署把它们连同误删
--   （导致"配置品类目标后每次部署值变空"，详见 148 根治）。加 target_type 守卫只杀真 store 假行。
DELETE FROM target_metric_values
 WHERE target_id IN (
   SELECT id FROM targets WHERE breakdown_level='store' AND branch_num='ALL' AND target_type='store'
 );
DELETE FROM targets WHERE breakdown_level='store' AND branch_num='ALL' AND target_type='store';
DO $$ BEGIN RAISE NOTICE 'Migration 117: 清 store 级 branch_num=ALL 假行（target_type 守卫，不误伤 hq 品类）'; END $$;

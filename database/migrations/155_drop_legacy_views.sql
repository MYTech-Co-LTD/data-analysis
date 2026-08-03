-- 155_drop_legacy_views.sql
-- 语义层改造收尾：手写旧视图全部下线（生成视图 report_*_gen + report_achievement_gen 已替代）
-- 1) get_targets_admin 改读 report_achievement_gen（原读 achievement_v，drop 前必须切）
-- 2) drop report_achievement_v（已由生成 report_achievement_gen 替代，双轨 diff=0 验证）
-- 3) drop 废弃 drill 视图（report_region_breakdown_gen 等已替代；先 drop _audit 再主视图）
-- 幂等：DROP VIEW IF EXISTS / DROP FUNCTION IF EXISTS 用 CREATE OR REPLACE 前先 drop。

-- ===== 1. get_targets_admin 切到生成视图 =====
DROP FUNCTION IF EXISTS get_targets_admin();
CREATE OR REPLACE FUNCTION get_targets_admin() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  FROM (SELECT * FROM report_achievement_gen WHERE target_level='total') t;
$function$;
GRANT EXECUTE ON FUNCTION get_targets_admin() TO authenticated, anon;

-- ===== 2. drop report_achievement_v（手写，report_achievement_gen 替代）=====
DROP VIEW IF EXISTS report_achievement_v CASCADE;

-- ===== 3. drop 废弃 drill 视图（audit 先于主视图）=====
DROP VIEW IF EXISTS report_store_sales_drill_v_audit;
DROP VIEW IF EXISTS report_store_sales_drill_v;
DROP VIEW IF EXISTS report_distribution_drill_v_audit;
DROP VIEW IF EXISTS report_distribution_drill_v;
DROP VIEW IF EXISTS report_outbound_drill_v_audit;
DROP VIEW IF EXISTS report_outbound_drill_v;
DROP VIEW IF EXISTS report_daily_sales_v;
DROP VIEW IF EXISTS report_daily_category_v;

DO $$ BEGIN RAISE NOTICE 'Migration 155: 手写旧视图下线（achievement_v → achievement_gen, drill 视图废弃）'; END $$;

-- 051_branch_admin.sql
-- 门店维护后台：branch_admin_v 视图(JOIN 战区+ext) + 4 个 SECURITY DEFINER RPC + GRANT
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW（不用 CREATE OR REPLACE，CLAUDE.md 坑）；IF NOT EXISTS；GRANT 幂等

-- ===== 1. branch_admin_v：dim_branch JOIN dim_region(战区) JOIN dim_branch_ext(分组/备注) =====
DROP VIEW IF EXISTS branch_admin_v CASCADE;
CREATE VIEW branch_admin_v AS
SELECT
  b.system_book_code, b.branch_num, b.branch_id, b.branch_code, b.branch_name,
  b.region_name, b.province, b.city, b.district, b.address, b.phone,
  b.enable, b.is_active,
  r.war_zone, r.sub_region,                                  -- 来自 dim_region
  e.custom_group, e.note,                                    -- 来自 dim_branch_ext
  CASE WHEN r.war_zone IS NULL AND b.region_name IS NOT NULL THEN true ELSE false END AS unmapped
FROM dim_branch b
LEFT JOIN dim_region r ON r.region_name = b.region_name
LEFT JOIN dim_branch_ext e ON e.system_book_code = b.system_book_code AND e.branch_num = b.branch_num
WHERE b.is_active = true;
ALTER VIEW branch_admin_v OWNER TO postgres;
ALTER VIEW branch_admin_v SET (security_invoker = true);
GRANT SELECT ON branch_admin_v TO authenticated, anon;

-- ===== 2. upsert_branch_ext：行内编辑 ext(custom_group/note)，SECURITY DEFINER 绕 RLS =====
CREATE OR REPLACE FUNCTION upsert_branch_ext(
  p_sbc TEXT, p_branch TEXT, p_group TEXT, p_note TEXT, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_branch_ext (system_book_code, branch_num, custom_group, note, updated_by, updated_at)
  VALUES (p_sbc, p_branch, p_group, p_note, p_by, NOW())
  ON CONFLICT (system_book_code, branch_num) DO UPDATE
    SET custom_group = EXCLUDED.custom_group, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 3. upsert_region：dim_region upsert（region_name 主键），SECURITY DEFINER =====
CREATE OR REPLACE FUNCTION upsert_region(
  p_region TEXT, p_war_zone TEXT, p_sub TEXT, p_display TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO dim_region (region_name, war_zone, sub_region, display_name, updated_at)
  VALUES (p_region, p_war_zone, p_sub, p_display, NOW())
  ON CONFLICT (region_name) DO UPDATE
    SET war_zone = EXCLUDED.war_zone, sub_region = EXCLUDED.sub_region, display_name = EXCLUDED.display_name, updated_at = NOW();
  RETURN jsonb_build_object('ok', true);
END $$;

-- ===== 4. upsert_regions_batch：批量 upsert dim_region（CSV 导入用）=====
CREATE OR REPLACE FUNCTION upsert_regions_batch(p_rows JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB; n INT := 0;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    PERFORM upsert_region(r->>'region_name', r->>'war_zone', r->>'sub_region', r->>'display_name');
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'count', n);
END $$;

-- ===== 5. get_unmapped_regions：dim_branch 里有但 dim_region 没映射的 region_name =====
DROP FUNCTION IF EXISTS get_unmapped_regions();
CREATE FUNCTION get_unmapped_regions() RETURNS TABLE(region_name TEXT, branch_count BIGINT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT b.region_name, COUNT(*) AS branch_count
    FROM dim_branch b
    LEFT JOIN dim_region r ON r.region_name = b.region_name
    WHERE b.is_active = true AND b.region_name IS NOT NULL AND r.region_name IS NULL
    GROUP BY b.region_name ORDER BY branch_count DESC;
END $$;

GRANT EXECUTE ON FUNCTION upsert_branch_ext(TEXT,TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_region(TEXT,TEXT,TEXT,TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION upsert_regions_batch(JSONB) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_unmapped_regions() TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 051_branch_admin completed'; END $$;

-- 115_recompute_breakdown_aggregates.sql
-- 修目标分解"子和不一致"：区域级(region_l2)/战区级目标是独立存储的，门店目标改动后不自动重算，
--   残留旧值（早期 branch_num 单列聚合 / 改革前门店集算的），导致子和满屏红字。
-- 解法：war_zone/region 级目标改为**门店目标的派生值**——
--   1) recompute_warzone_region_targets(p_parent_id)：按门店(composite join dim_branch)重算战区/区域目标和；
--   2) upsert_target_breakdown 末尾自动调用，保存门店即重算上级，杜绝漂移。
-- 复合键(system_book_code, branch_num)聚合，不重不漏（门店键铁律）。幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest。

-- ============================================================
-- ① 重算函数：删除并按门店和重建 war_zone / region_l2 目标
-- ============================================================
CREATE OR REPLACE FUNCTION recompute_warzone_region_targets(p_parent_id BIGINT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_parent targets%ROWTYPE;
BEGIN
  SELECT * INTO v_parent FROM targets WHERE id = p_parent_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- 清旧 war_zone/region_l2 目标（先 metric_values 再 targets，免 FK 悬挂）
  DELETE FROM target_metric_values
   WHERE target_id IN (SELECT id FROM targets WHERE parent_target_id = p_parent_id AND breakdown_level IN ('war_zone','region_l2'));
  DELETE FROM targets
   WHERE parent_target_id = p_parent_id AND breakdown_level IN ('war_zone','region_l2');

  -- region_l2：每个有门店的 (war_zone, region_l2) 建一行，metric = 该区域门店目标之和
  WITH ins AS (
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, war_zone, region_l2, created_by, created_at)
    SELECT DISTINCT
           v_parent.name || '-' || db.first_level_region || '-' || COALESCE(db.second_level_region,''),
           'ALL', 'ALL', v_parent.start_date, v_parent.end_date, 'active', 'breakdown',
           p_parent_id, v_parent.target_type, 'region_l2', db.first_level_region, db.second_level_region, 'system', NOW()
      FROM targets s
      JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
     WHERE s.parent_target_id = p_parent_id AND s.breakdown_level = 'store' AND s.branch_num <> 'ALL'
       AND db.first_level_region IS NOT NULL
    RETURNING id, war_zone, region_l2
  )
  INSERT INTO target_metric_values(target_id, metric_code, target_value)
  SELECT i.id, mv.metric_code, SUM(mv.target_value)
    FROM ins i
    JOIN targets s ON s.parent_target_id = p_parent_id AND s.breakdown_level = 'store' AND s.branch_num <> 'ALL'
    JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
                       AND db.first_level_region = i.war_zone
                       AND COALESCE(db.second_level_region,'') = COALESCE(i.region_l2,'')
    JOIN target_metric_values mv ON mv.target_id = s.id
   GROUP BY i.id, mv.metric_code;

  -- war_zone：每个有门店的战区建一行，metric = 该战区门店目标之和
  WITH ins AS (
    INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, war_zone, region_l2, created_by, created_at)
    SELECT DISTINCT
           v_parent.name || '-' || db.first_level_region,
           'ALL', 'ALL', v_parent.start_date, v_parent.end_date, 'active', 'breakdown',
           p_parent_id, v_parent.target_type, 'war_zone', db.first_level_region, NULL, 'system', NOW()
      FROM targets s
      JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
     WHERE s.parent_target_id = p_parent_id AND s.breakdown_level = 'store' AND s.branch_num <> 'ALL'
       AND db.first_level_region IS NOT NULL
    RETURNING id, war_zone
  )
  INSERT INTO target_metric_values(target_id, metric_code, target_value)
  SELECT i.id, mv.metric_code, SUM(mv.target_value)
    FROM ins i
    JOIN targets s ON s.parent_target_id = p_parent_id AND s.breakdown_level = 'store' AND s.branch_num <> 'ALL'
    JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
                       AND db.first_level_region = i.war_zone
    JOIN target_metric_values mv ON mv.target_id = s.id
   GROUP BY i.id, mv.metric_code;
END $$;
GRANT EXECUTE ON FUNCTION recompute_warzone_region_targets(BIGINT) TO authenticated, anon;
COMMENT ON FUNCTION recompute_warzone_region_targets(BIGINT) IS
  '按门店目标(composite key)重算并重建 war_zone/region_l2 级目标，修子和漂移；由 upsert_target_breakdown 自动调用';

-- ============================================================
-- ② upsert_target_breakdown 末尾自动重算（仅当本次写了 store 行）
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_level TEXT; v_branch TEXT; v_wz TEXT; v_r2 TEXT; v_m TEXT;
  v_sub BIGINT; v_store_sbc TEXT; n INT := 0; v_has_store BOOLEAN := false;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_level := COALESCE(v_row->>'breakdown_level', 'store');
    v_branch := v_row->>'branch_num';
    v_wz := v_row->>'war_zone';
    v_r2 := v_row->>'region_l2';
    IF v_level='store' THEN
      v_store_sbc := COALESCE(v_row->>'system_book_code', p_sbc);
      SELECT first_level_region, second_level_region INTO v_wz, v_r2
        FROM dim_branch WHERE system_book_code=v_store_sbc AND branch_num=v_branch;
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='store'
        AND system_book_code=v_store_sbc AND branch_num=v_branch;
      v_has_store := true;
    ELSE
      v_store_sbc := p_sbc;
      IF v_level='war_zone' THEN
        SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='war_zone' AND war_zone=v_wz LIMIT 1;
      ELSIF v_level='region_l2' THEN
        SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='region_l2' AND war_zone=v_wz AND region_l2=v_r2 LIMIT 1;
      END IF;
    END IF;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, war_zone, region_l2, created_by, created_at)
      SELECT t.name||'-'||COALESCE(v_branch, v_wz, v_r2), v_store_sbc, COALESCE(v_branch,'ALL'), t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, t.target_type, v_level, v_wz, v_r2, p_by, NOW()
      FROM targets t WHERE t.id=p_parent_id RETURNING id INTO v_sub;
    ELSE
      UPDATE targets SET system_book_code=v_store_sbc, war_zone=v_wz, region_l2=v_r2 WHERE id=v_sub;
      DELETE FROM target_metric_values WHERE target_id=v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value) VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n := n+1;
  END LOOP;

  -- 保存门店后自动重算战区/区域（war_zone/region 级目标 = 门店和，杜绝漂移）
  IF v_has_store THEN
    PERFORM recompute_warzone_region_targets(p_parent_id);
  END IF;

  RETURN jsonb_build_object('ok',true,'count',n);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 115: recompute_warzone_region_targets + upsert 末尾自动重算（修子和漂移）'; END $$;

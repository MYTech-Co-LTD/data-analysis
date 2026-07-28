-- 106_upsert_prefer_branch_number.sql
-- upsert_target_breakdown: 门店级优先用 branch_number（全局唯一门店键）解析 store，
--   没有 branch_number 才回退 system_book_code+branch_num。
-- 修：导入路径只带 branch_number（无 system_book_code）时，旧 099 回退 p_sbc='ALL'
--   → branch_number='ALL-xxxx' → FK 拒（"保存失败 ALL-0109"）。
-- 签名/调用点不变。幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest。
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_level TEXT; v_branch TEXT; v_bn TEXT; v_wz TEXT; v_r2 TEXT; v_m TEXT;
  v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_level := COALESCE(v_row->>'breakdown_level', 'store');
    v_branch := v_row->>'branch_num';
    v_wz := v_row->>'war_zone';
    v_r2 := v_row->>'region_l2';
    IF v_level='store' THEN
      v_bn := v_row->>'branch_number';
      IF v_bn IS NOT NULL AND v_bn <> '' THEN
        -- branch_number 优先（前端手动行/Excel 导入行都带）：一次查出 sbc+branch_num+战区+二级
        SELECT system_book_code, branch_num, first_level_region, second_level_region
          INTO v_store_sbc, v_branch, v_wz, v_r2
          FROM dim_branch WHERE branch_number=v_bn;
        IF v_store_sbc IS NULL THEN
          RAISE EXCEPTION 'branch_number % 不在 dim_branch（无法解析门店）', v_bn USING ERRCODE='23503';
        END IF;
      ELSE
        -- 回退：旧路径用 system_book_code+branch_num
        v_store_sbc := COALESCE(v_row->>'system_book_code', p_sbc);
        SELECT first_level_region, second_level_region INTO v_wz, v_r2
          FROM dim_branch WHERE system_book_code=v_store_sbc AND branch_num=v_branch;
      END IF;
    ELSE
      v_store_sbc := p_sbc;  -- 战区/区域级 brand 同 parent
    END IF;
    IF v_level='store' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='store'
        AND system_book_code=v_store_sbc AND branch_num=v_branch;
    ELSIF v_level='war_zone' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='war_zone' AND war_zone=v_wz LIMIT 1;
    ELSIF v_level='region_l2' THEN
      SELECT id INTO v_sub FROM targets WHERE parent_target_id=p_parent_id AND breakdown_level='region_l2' AND war_zone=v_wz AND region_l2=v_r2 LIMIT 1;
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
    n:=n+1;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'count',n);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 106: upsert 优先 branch_number 解析门店(修导入无sbc→ALL→FK拒)'; END $$;

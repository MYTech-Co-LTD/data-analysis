-- 163_upsert_target_breakdown_rollup_total.sql
-- 修目标看板拿不到 sale/delivery 目标值：新逻辑从门店层层汇总成总目标，
-- 但 upsert_target_breakdown（099）只写 breakdown，不汇总 parent total；
-- upsert_target_total 又把 total 4 metric 设 0 -> total sale/delivery=0（outbound_amt 由 upsert_hq_category_breakdown 的 p_total_metrics 写入，有值）。
-- 修：upsert_target_breakdown 循环后汇总门店 breakdown sale/delivery/outbound_profit -> parent total（最细优先 store，回退 region_l2/war_zone）。
-- 幂等：CREATE OR REPLACE；ON CONFLICT 更新。重新汇总：重导 breakdown 或手动 UPDATE。
CREATE OR REPLACE FUNCTION upsert_target_breakdown(
  p_parent_id BIGINT, p_sbc TEXT, p_rows JSONB, p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_row JSONB; v_level TEXT; v_branch TEXT; v_wz TEXT; v_r2 TEXT; v_m TEXT;
  v_sub BIGINT; v_store_sbc TEXT; n INT:=0;
  v_rollup_metric TEXT; v_rollup_sum NUMERIC;
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
    ELSE
      v_store_sbc := p_sbc;
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

  -- 汇总门店 breakdown sale/delivery/outbound_profit -> parent total（新逻辑：门店层层汇总成总目标）
  -- 最细级优先（store -> region_l2 -> war_zone），取第一个有值的级 SUM，避免多级翻倍
  FOREACH v_rollup_metric IN ARRAY ARRAY['sale','delivery','outbound_profit'] LOOP
    SELECT SUM(tmv.target_value) INTO v_rollup_sum
    FROM target_metric_values tmv JOIN targets t ON t.id=tmv.target_id
    WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='store' AND tmv.metric_code=v_rollup_metric;
    IF v_rollup_sum IS NULL OR v_rollup_sum = 0 THEN
      SELECT SUM(tmv.target_value) INTO v_rollup_sum
      FROM target_metric_values tmv JOIN targets t ON t.id=tmv.target_id
      WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='region_l2' AND tmv.metric_code=v_rollup_metric;
    END IF;
    IF v_rollup_sum IS NULL OR v_rollup_sum = 0 THEN
      SELECT SUM(tmv.target_value) INTO v_rollup_sum
      FROM target_metric_values tmv JOIN targets t ON t.id=tmv.target_id
      WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='war_zone' AND tmv.metric_code=v_rollup_metric;
    END IF;
    IF v_rollup_sum IS NOT NULL THEN
      INSERT INTO target_metric_values(target_id, metric_code, target_value)
      VALUES (p_parent_id, v_rollup_metric, v_rollup_sum)
      ON CONFLICT (target_id, metric_code) DO UPDATE SET target_value = EXCLUDED.target_value;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok',true,'count',n);
END $$;
GRANT EXECUTE ON FUNCTION upsert_target_breakdown(BIGINT,TEXT,JSONB,TEXT) TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 163: upsert_target_breakdown 汇总门店 breakdown sale/delivery -> total'; END $$;

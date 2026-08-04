-- 160_close_target_can_see_cost.sql
-- 修 close_target 快照毛利为空：159 从 report_achievement_gen 拷贝，但 outbound_profit 受 can_see_cost 脱敏，
-- SECURITY DEFINER 下 current_setting('request.jwt.claims.can_see_cost')=NULL -> COALESCE(NULL,false)=false -> outbound_profit=NULL。
-- 快照应存实际毛利（数据固化，非权限视图）。修：拷贝前 set_config can_see_cost=true（事务级），让 report_achievement_gen 走实际值。
-- 幂等：CREATE OR REPLACE。重固化误关目标：先 UPDATE status='active'，再调 close_target。
CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t_rec RECORD;
  v_count INT;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;

  -- 设 can_see_cost=true（事务级），让 report_achievement_gen 的 outbound_profit 走实际值（快照存实际毛利，不脱敏）
  PERFORM set_config('request.jwt.claims.can_see_cost', 'true', true);

  -- 从 report_achievement_gen 拷贝 actual/rate -> 快照（拷贝时 target active，视图走实时 actual）
  INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
  SELECT p_target_id, v.metric_code, v.actual_value, v.achievement_rate, COALESCE(v.data_status, 'complete'), now()
  FROM report_achievement_gen v
  WHERE v.target_id = p_target_id AND v.target_level = 'total'
  ON CONFLICT (target_id, metric_code) DO UPDATE SET
    actual_value = EXCLUDED.actual_value, achievement_rate = EXCLUDED.achievement_rate,
    data_status = EXCLUDED.data_status, snapshot_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE targets SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = p_target_id;

  RETURN jsonb_build_object(
    'ok', true,
    'target_id', p_target_id,
    'snapshotted', v_count,
    'metrics', (SELECT jsonb_agg(jsonb_build_object('metric', metric_code, 'actual', actual_value, 'rate', achievement_rate, 'status', data_status))
                FROM target_snapshots WHERE target_id = p_target_id));
END;
$$;
GRANT EXECUTE ON FUNCTION public.close_target(BIGINT) TO authenticated, project_admin;
DO $$ BEGIN RAISE NOTICE 'Migration 160: close_target 设 can_see_cost=true 拷贝实际毛利（修快照毛利空）'; END $$;

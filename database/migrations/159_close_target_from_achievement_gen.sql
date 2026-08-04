-- 159_close_target_from_achievement_gen.sql
-- 重写 close_target：从 report_achievement_gen 拷贝快照。
-- 046 版 bug：sale 按 system_book_code+branch_num 过滤，total 目标 'ALL' 匹配不到 -> actual=0；
--   只处理 sale，delivery/outbound_amt/outbound_profit 全 not_ready 占位。
-- 140 版用 report_achievement_v 拷贝，但 155 已 DROP report_achievement_v -> 140 未生效（close_target 退回 046）。
-- 159 改用 report_achievement_gen（生成器产物，含 sale/delivery/outbound_amt actual + 考核门店口径），与语义层口径一致。
-- 幂等：ON CONFLICT 更新；关闭前 target 须 active（report_achievement_gen 对 active 走实时 actual，closed 走快照）。
-- 注意：outbound_profit 受 can_see_cost 脱敏，SECURITY DEFINER 下 current_setting 为 NULL -> 拷贝为 NULL（同 140 设计）。
CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t_rec RECORD;
  v_count INT;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;

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
DO $$ BEGIN RAISE NOTICE 'Migration 159: close_target 改从 report_achievement_gen 拷贝快照（140 用 achievement_v 已被 155 DROP）'; END $$;

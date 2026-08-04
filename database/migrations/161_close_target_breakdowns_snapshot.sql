-- 161_close_target_breakdowns_snapshot.sql
-- 修 close_target 丢了 breakdowns 快照 + 明细毛利 null。
-- 154 close_target 含看板模块全量快照（6 模块视图 -> target_snapshot_breakdowns），但 159 重写时只拷贝 total（target_snapshots），
--   丢了 breakdowns 逻辑 -> 159 后 close_target 不再写 breakdowns（旧数据残留，毛利 null）。
-- 且 154 快照视图 SELECT 时 can_see_cost=NULL（SECURITY DEFINER）-> 各视图毛利脱敏 null（breakdowns 毛利全 null）。
-- 161 恢复 breakdowns 快照逻辑（154 第 65-79），复用 160 的 set_config can_see_cost=true -> 视图毛利走实际值。
-- 幂等：CREATE OR REPLACE。重固化：先 UPDATE status='active'，再调 close_target。
CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t_rec RECORD;
  v_count INT;
  v_module RECORD;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;

  -- 设 can_see_cost=true（事务级），让 report_achievement_gen + 各看板视图的毛利走实际值（快照存实际毛利，不脱敏）
  PERFORM set_config('request.jwt.claims.can_see_cost', 'true', true);

  -- 从 report_achievement_gen 拷贝 actual/rate -> target_snapshots（total 4 metric）
  INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
  SELECT p_target_id, v.metric_code, v.actual_value, v.achievement_rate, COALESCE(v.data_status, 'complete'), now()
  FROM report_achievement_gen v
  WHERE v.target_id = p_target_id AND v.target_level = 'total'
  ON CONFLICT (target_id, metric_code) DO UPDATE SET
    actual_value = EXCLUDED.actual_value, achievement_rate = EXCLUDED.achievement_rate,
    data_status = EXCLUDED.data_status, snapshot_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- 看板模块全量快照（仅 total 目标）：从各视图 SELECT 转 JSON 存 target_snapshot_breakdowns
  -- can_see_cost=true 已设 -> 视图毛利实际值（不脱敏）；target 仍 active -> 视图 tgt 含此 target
  IF t_rec.target_level = 'total' THEN
    FOR v_module IN SELECT * FROM (VALUES
      ('brand',           'report_brand_metric_gen'),
      ('region',          'report_region_breakdown_gen'),
      ('category',        'report_category_summary_gen'),
      ('item',            'report_item_breakdown_gen'),
      ('supply',          'report_supply_chain_outbound_gen'),
      ('wholesale_daily', 'report_wholesale_daily_gen')
    ) AS m(module, viewname) LOOP
      EXECUTE format(
        'INSERT INTO target_snapshot_breakdowns(target_id, module, data) VALUES (%L, %L, COALESCE((SELECT to_jsonb(array_agg(row_to_json(t))) FROM (SELECT * FROM %I WHERE target_id = %L) t), ''[]''::jsonb)) ON CONFLICT (target_id, module) DO UPDATE SET data = EXCLUDED.data, snapshot_at = now()',
        p_target_id, v_module.module, v_module.viewname, p_target_id
      );
    END LOOP;
  END IF;

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
DO $$ BEGIN RAISE NOTICE 'Migration 161: close_target 恢复 breakdowns 快照 + can_see_cost=true 毛利实际值'; END $$;

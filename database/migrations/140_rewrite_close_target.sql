-- 140_rewrite_close_target.sql
-- 重写 close_target：从 report_achievement_v 拷贝快照（替代 046 的硬编码取数）
--
-- 046 版问题：
--   1. 只处理 'sale'，delivery/outbound_amt/outbound_profit 全写 not_ready/NULL
--   2. sale 按 system_book_code+branch_num 过滤，总目标 branch_num='ALL' 匹配不到 → actual=0
--   3. 口径硬编码，与 metric_registry 语义层脱节
--
-- 新实现：close 时目标仍 active，report_achievement_v 返回实时 actual/rate（语义层口径），
--   直接拷贝到 target_snapshots → 零口径代码，永远与语义层一致。
-- 拷贝后再 UPDATE status='closed'（之后 report_achievement_v 对该目标读快照，三态闭环）。
-- 幂等：ON CONFLICT 更新（校准后可重跑刷新快照）。

CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  t_rec RECORD;
  v_count INT;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'target not found');
  END IF;

  -- 拷贝 report_achievement_v 实时值 → 快照（拷贝时目标 active，视图为实时口径）
  INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
  SELECT p_target_id, v.metric_code, v.actual_value, v.achievement_rate, COALESCE(v.data_status, 'complete'), now()
  FROM report_achievement_v v
  WHERE v.target_id = p_target_id
    AND v.target_level = 'total'
  ON CONFLICT (target_id, metric_code) DO UPDATE SET
    actual_value = EXCLUDED.actual_value,
    achievement_rate = EXCLUDED.achievement_rate,
    data_status = EXCLUDED.data_status,
    snapshot_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;

  UPDATE targets SET status = 'closed', closed_at = now(), updated_at = now() WHERE id = p_target_id;

  RETURN jsonb_build_object(
    'ok', true,
    'target_id', p_target_id,
    'snapshotted', v_count,
    'metrics', (SELECT jsonb_agg(jsonb_build_object('metric', metric_code, 'actual', actual_value, 'rate', achievement_rate, 'status', data_status))
                FROM target_snapshots WHERE target_id = p_target_id)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.close_target(BIGINT) TO anon, authenticated, project_admin;

DO $$ BEGIN RAISE NOTICE 'Migration 140: close_target 重写完成（快照=report_achievement_v 实时值拷贝）'; END $$;
-- 162_close_target_item_top_snapshot.sql
-- 优化 closed 目标打开慢：item 快照 2.58MB（6569 商品）拖慢 SSR。
-- close_target 加 item_top module：只存 TOP20 sale + TOP20 outbound + total（几 KB），给 top 榜 SSR 读。
-- item 全量快照仍存（item module），给出库明细分页（client fetch，不在 SSR）。
-- 幂等：CREATE OR REPLACE。重固化：UPDATE status='active' + close_target。
CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t_rec RECORD;
  v_count INT;
  v_module RECORD;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;

  PERFORM set_config('request.jwt.claims.can_see_cost', 'true', true);

  INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
  SELECT p_target_id, v.metric_code, v.actual_value, v.achievement_rate, COALESCE(v.data_status, 'complete'), now()
  FROM report_achievement_gen v
  WHERE v.target_id = p_target_id AND v.target_level = 'total'
  ON CONFLICT (target_id, metric_code) DO UPDATE SET
    actual_value = EXCLUDED.actual_value, achievement_rate = EXCLUDED.achievement_rate,
    data_status = EXCLUDED.data_status, snapshot_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF t_rec.target_level = 'total' THEN
    -- item_top: TOP20 + total（给 top 榜 SSR，避免读全量 item 2.58MB）
    EXECUTE format(
      'INSERT INTO target_snapshot_breakdowns(target_id, module, data) VALUES (%L, ''item_top'', jsonb_build_object(
        ''saleTop'', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (SELECT item_code, item_name, category_name, sale_amount, sale_profit FROM %I WHERE target_id = %L AND sale_amount IS NOT NULL ORDER BY sale_amount DESC LIMIT 20) t), ''[]''::jsonb),
        ''outboundTop'', COALESCE((SELECT jsonb_agg(row_to_json(t)) FROM (SELECT item_code, item_name, category_name, outbound_amount, outbound_profit FROM %I WHERE target_id = %L AND outbound_amount IS NOT NULL ORDER BY outbound_amount DESC LIMIT 20) t), ''[]''::jsonb),
        ''totalSaleAmount'', COALESCE((SELECT SUM(sale_amount) FROM %I WHERE target_id = %L), 0),
        ''totalSaleProfit'', COALESCE((SELECT SUM(sale_profit) FROM %I WHERE target_id = %L), 0),
        ''totalOutboundAmount'', COALESCE((SELECT SUM(outbound_amount) FROM %I WHERE target_id = %L), 0),
        ''totalOutboundProfit'', COALESCE((SELECT SUM(outbound_profit) FROM %I WHERE target_id = %L), 0)
      )) ON CONFLICT (target_id, module) DO UPDATE SET data = EXCLUDED.data, snapshot_at = now()',
      p_target_id, 'report_item_breakdown_gen', p_target_id, 'report_item_breakdown_gen', p_target_id, 'report_item_breakdown_gen', p_target_id, 'report_item_breakdown_gen', p_target_id, 'report_item_breakdown_gen', p_target_id, 'report_item_breakdown_gen', p_target_id
    );

    -- 6 模块全量快照（含 item 全量，给分页；can_see_cost=true 已设 -> 毛利实际值）
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
DO $$ BEGIN RAISE NOTICE 'Migration 162: close_target 加 item_top module（TOP20+total，优化 SSR 打开慢）'; END $$;

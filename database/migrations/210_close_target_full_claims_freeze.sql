-- 210_close_target_full_claims_freeze.sql
-- 修 823 空壳固化：close_target 自 2026-08-17/18 权限收缩后，SECURITY DEFINER + 服务级调用
-- （__target_close 定时任务 / 手动关闭路由，INSFORGE_API_KEY 身份）无全量 data_scope，
-- 从 report_achievement_gen / report_*_gen 拷贝时 scope 过滤把全部事实行滤空 →
-- target_snapshots actual=0 / breakdowns 全空壳（实例：823 于 2026-09-02 05:10 自动固化）。
-- 旧修法 set_config('request.jwt.claims.can_see_cost', ...) 是死代码（点分 GUC，权限改造后
-- 函数族只读 request.jwt.claims 整块 JSON：scope_brand_keys/scope_branch_keys 读 data_scope.
-- brands/branch_nums（201），can_cost_visible 只认 fields.cost（185））。
-- 修法：函数体内注入全量 claims JSON blob——固化是服务级权威定格（固化时无"某个用户"语义，
-- 快照行为公司级聚合无门店键，千人千面只能在读取层实现：KPI 层 report_achievement_gen 对
-- branch_scope_limited 用户 live 重算+分母收缩；下钻 gen 视图 target_status ['active','closed']
-- 统一 live 重算，行级 scope 天然裁剪；target_snapshot_breakdowns JSONB 降级为审计存档）。
-- 幂等：CREATE OR REPLACE。重固化既有空壳：UPDATE targets SET status='active' WHERE id=823;
--   SELECT close_target(823);（数据修复走一次性 SQL，不在迁移内——migrate.sh 全量重跑会反复重冻结）
CREATE OR REPLACE FUNCTION public.close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  t_rec RECORD;
  v_count INT;
  v_module RECORD;
BEGIN
  SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;

  -- 服务级全量固化身份：scope_brand_keys()/scope_branch_keys() → {'} 全放行，can_cost_visible() → true
  -- （毛利实际值定格全量真值；读取层脱敏由视图 can_cost_visible() 分支按用户裁剪）
  PERFORM set_config('request.jwt.claims',
    '{"data_scope":{"brands":["*"],"branch_nums":["*"]},"fields":{"cost":true}}', true);

  INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
  SELECT p_target_id, v.metric_code, v.actual_value, v.achievement_rate, COALESCE(v.data_status, 'complete'), now()
  FROM report_achievement_gen v
  WHERE v.target_id = p_target_id AND v.target_level = 'total'
  ON CONFLICT (target_id, metric_code) DO UPDATE SET
    actual_value = EXCLUDED.actual_value, achievement_rate = EXCLUDED.achievement_rate,
    data_status = EXCLUDED.data_status, snapshot_at = now();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF t_rec.target_level = 'total' THEN
    -- item_top: TOP20 + total（审计存档；前端 SSR 改走 live 视图，见 view-configs 目标窗口 2026-09-02 修订）
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

    -- 6 模块全量快照（审计存档；claims 已注入全量 → 全量真值定格）
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
DO $$ BEGIN RAISE NOTICE 'Migration 210: close_target 注入全量 claims（修 823 空壳固化，服务级权威定格）'; END $$;

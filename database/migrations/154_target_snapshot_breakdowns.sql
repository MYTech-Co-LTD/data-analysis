-- 154_target_snapshot_breakdowns.sql
-- 目标定格机制 Part 2：关闭目标时把看板各模块视图输出全量快照成 JSONB，
-- 前端 closed 目标看板读快照渲染（不再碰视图，避免重算 + 定格值漂移）。
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE FUNCTION。

-- ===== 快照表：每 (target_id, module) 一行，data 存视图输出全量 JSON 数组 =====
CREATE TABLE IF NOT EXISTS target_snapshot_breakdowns (
    target_id   BIGINT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
    module      TEXT NOT NULL,
    data        JSONB NOT NULL DEFAULT '[]'::jsonb,
    snapshot_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (target_id, module)
);
CREATE INDEX IF NOT EXISTS idx_tsb_target ON target_snapshot_breakdowns(target_id);

ALTER TABLE target_snapshot_breakdowns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tsb_read ON target_snapshot_breakdowns;
CREATE POLICY tsb_read ON target_snapshot_breakdowns FOR SELECT TO authenticated USING (true);
GRANT SELECT ON target_snapshot_breakdowns TO authenticated;

-- ===== close_target 扩展：关闭前快照看板模块（仅 total 目标）=====
-- 目标此时仍 active，视图可算；SECURITY DEFINER 无 JWT → perm 过滤放行全量（= 管理员视角的展示数据）
CREATE OR REPLACE FUNCTION close_target(p_target_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    t_rec RECORD;
    v_actual NUMERIC(14,2);
    v_days_have INTEGER;
    v_total_days INTEGER;
    v_dstatus TEXT;
    v_metric TEXT;
    v_tval NUMERIC(14,2);
    v_module RECORD;
BEGIN
    SELECT * INTO t_rec FROM targets WHERE id = p_target_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'target not found'); END IF;
    v_total_days := t_rec.end_date - t_rec.start_date + 1;
    FOR v_metric IN SELECT metric_code FROM target_metric_values WHERE target_id = p_target_id LOOP
        SELECT target_value INTO v_tval FROM target_metric_values WHERE target_id=p_target_id AND metric_code=v_metric;
        IF v_metric = 'sale' THEN
            SELECT COALESCE(SUM(total_sale),0), COUNT(DISTINCT biz_date)
              INTO v_actual, v_days_have
              FROM report_daily_sales
             WHERE system_book_code = t_rec.system_book_code
               AND branch_num = t_rec.branch_num
               AND biz_date BETWEEN t_rec.start_date AND t_rec.end_date;
            v_dstatus := CASE WHEN v_days_have = 0 THEN 'missing'
                              WHEN v_days_have < v_total_days THEN 'partial' ELSE 'complete' END;
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, v_actual,
                    CASE WHEN v_tval > 0 THEN round((v_actual / v_tval)::numeric, 4) ELSE NULL END,
                    v_dstatus, now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET
              actual_value=EXCLUDED.actual_value, achievement_rate=EXCLUDED.achievement_rate,
              data_status=EXCLUDED.data_status, snapshot_at=now();
        ELSE
            INSERT INTO target_snapshots(target_id, metric_code, actual_value, achievement_rate, data_status, snapshot_at)
            VALUES (p_target_id, v_metric, NULL, NULL, 'not_ready', now())
            ON CONFLICT (target_id, metric_code) DO UPDATE SET data_status='not_ready', snapshot_at=now();
        END IF;
    END LOOP;

    -- 看板模块全量快照（仅 total 目标：看板按 total 目标渲染；store/breakdown 目标无看板）
    -- 视图输出即展示数据（怎么展示的就怎么存），target 仍 active 所以视图能算
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

    UPDATE targets SET status='closed', closed_at=now(), updated_at=now() WHERE id = p_target_id;
    RETURN jsonb_build_object('ok', true, 'target_id', p_target_id, 'metrics',
      (SELECT jsonb_agg(jsonb_build_object('metric', metric_code, 'actual', actual_value, 'rate', achievement_rate, 'status', data_status))
       FROM target_snapshots WHERE target_id = p_target_id));
END $$;
GRANT EXECUTE ON FUNCTION close_target(BIGINT) TO authenticated;

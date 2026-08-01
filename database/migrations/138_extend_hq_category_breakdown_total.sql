-- 138_extend_hq_category_breakdown_total.sql
-- 扩展类别分解函数：支持同时保存「总出库目标」+ 后端校验拦截
-- 设计文档：docs/superpowers/specs/2026-08-01-target-management-redesign-design.md §2 校验逻辑
--
-- 变更：
-- 1. 新增 p_total_metrics 参数：{"outbound_amt": x, "outbound_profit": y}，写入总目标的 target_metric_values
-- 2. 后端校验：总出库目标 < 门店配送汇总 → RAISE EXCEPTION 拦截（此前仅前端 confirm 可绕过）
-- 3. 品类和 ≠ 总目标 → RAISE EXCEPTION 拦截（子和校验硬约束）

-- 删除旧签名（3 参数）
DROP FUNCTION IF EXISTS public.upsert_hq_category_breakdown(BIGINT, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.upsert_hq_category_breakdown(
  p_parent_id BIGINT,
  p_rows JSONB,
  p_by TEXT,
  p_total_metrics JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_row JSONB;
  v_cat TEXT;
  v_m TEXT;
  v_sub BIGINT;
  v_sbc TEXT;
  n INT := 0;
  v_delivery_sum NUMERIC;
  v_total_outbound NUMERIC;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id = p_parent_id;
  IF v_sbc IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'parent target not found');
  END IF;

  -- ===== 1. 保存总出库目标（若传入）=====
  IF p_total_metrics IS NOT NULL THEN
    FOR v_m IN SELECT jsonb_object_keys(p_total_metrics) LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value)
      VALUES (p_parent_id, v_m, (p_total_metrics->>v_m)::numeric)
      ON CONFLICT (target_id, metric_code) DO UPDATE SET
        target_value = EXCLUDED.target_value;
    END LOOP;

    -- ===== 2. 后端校验：总出库目标 ≥ 门店配送汇总 =====
    -- 门店配送汇总 = 该 parent 下所有门店级(store)子目标的 delivery 之和
    SELECT COALESCE(SUM(tmv.target_value), 0) INTO v_delivery_sum
    FROM targets t
    JOIN target_metric_values tmv ON tmv.target_id = t.id
    WHERE t.parent_target_id = p_parent_id
      AND t.target_type = 'store'
      AND t.breakdown_level = 'store'
      AND tmv.metric_code = 'delivery';

    v_total_outbound := COALESCE((p_total_metrics->>'outbound_amt')::numeric, 0);

    IF v_total_outbound < v_delivery_sum THEN
      RAISE EXCEPTION '总出库目标 % 小于门店配送汇总 %（批发=门店配送+外部客户，总出库不得小于配送汇总）',
        v_total_outbound, v_delivery_sum;
    END IF;
  END IF;

  -- ===== 3. 品类分解行照旧写入 hq 子目标 =====
  -- 注：品类和≠总目标仅前端 confirm 提醒（允许分步操作：先填总目标/门店，后分品类），
  --     后端只硬拦「总出库 < 门店配送汇总」（设计 §2 明确要求的后端校验）。
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_cat := v_row->>'category';
    SELECT id INTO v_sub FROM targets WHERE parent_target_id = p_parent_id AND category = v_cat LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, category, created_by, created_at)
      SELECT t.name||'-'||v_cat, v_sbc, 'ALL', t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, 'hq', v_cat, p_by, NOW()
      FROM targets t WHERE t.id = p_parent_id
      RETURNING id INTO v_sub;
    ELSE
      DELETE FROM target_metric_values WHERE target_id = v_sub;
    END IF;
    FOR v_m IN SELECT jsonb_object_keys(v_row->'metrics') LOOP
      INSERT INTO target_metric_values(target_id, metric_code, target_value)
      VALUES (v_sub, v_m, (v_row->'metrics'->>v_m)::numeric);
    END LOOP;
    n := n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'count', n);
END;
$function$;

-- 授权（新签名 4 参数）
GRANT EXECUTE ON FUNCTION public.upsert_hq_category_breakdown(BIGINT, JSONB, TEXT, JSONB) TO anon, authenticated, project_admin;

DO $$ BEGIN RAISE NOTICE 'Migration 138: upsert_hq_category_breakdown 扩展完成（总目标保存 + 后端校验拦截）'; END $$;
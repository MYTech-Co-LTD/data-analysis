-- 148_fix_hq_category_breakdown_level.sql
-- 修 bug：upsert_hq_category_breakdown 创建 hq 品类目标时，INSERT 漏写 breakdown_level，
--   被 targets.breakdown_level DEFAULT 'store' 填成 'store'。hq 品类行又是 branch_num='ALL'，
--   于是每次部署 migrate.sh 重跑 117 号清理（DELETE WHERE breakdown_level='store' AND branch_num='ALL'）
--   把 hq 品类目标连同误删 → "配置品类目标后每次部署值变空"。
--
-- 根治：
--   1) 函数 INSERT 显式 breakdown_level=NULL（hq 品类目标无地理粒度，breakdown_level 仅 store 型有效）；
--   2) 回填现存 hq 行 breakdown_level=NULL（修复前已建的行，免再被 117 删；117 已加 target_type='store' 守卫双保险）。
-- 幂等：CREATE OR REPLACE FUNCTION + UPDATE 重跑安全。

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

  -- ===== 3. 品类分解行写入 hq 子目标（breakdown_level 显式 NULL，防被 117 误删）=====
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_cat := v_row->>'category';
    SELECT id INTO v_sub FROM targets WHERE parent_target_id = p_parent_id AND target_type='hq' AND category = v_cat LIMIT 1;
    IF v_sub IS NULL THEN
      INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, parent_target_id, target_type, breakdown_level, category, created_by, created_at)
      SELECT t.name||'-'||v_cat, v_sbc, 'ALL', t.start_date, t.end_date, 'active', 'breakdown', p_parent_id, 'hq', NULL, v_cat, p_by, NOW()
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

GRANT EXECUTE ON FUNCTION public.upsert_hq_category_breakdown(BIGINT, JSONB, TEXT, JSONB) TO anon, authenticated, project_admin;

-- 回填：现存 hq 品类目标 breakdown_level 置 NULL（修复 138 漏设导致被默认值 'store' 填充的行）
UPDATE targets SET breakdown_level = NULL WHERE target_type = 'hq' AND breakdown_level IS NOT NULL;

DO $$ BEGIN RAISE NOTICE 'Migration 148: upsert_hq_category_breakdown INSERT 显式 breakdown_level=NULL + 回填现存 hq 行（修每次部署品类目标被 117 误删）'; END $$;

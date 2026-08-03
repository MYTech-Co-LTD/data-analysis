-- 156_fix_total_target_brand_all.sql
-- 总目标(全公司)的品牌范围应为 ALL（两品牌合计）——upsert_target_total 硬编码 '3120' 导致
-- 新建总目标 KPI 只统计熊喵（实测坑 2026-08-03：823 8月目标 system_book_code='3120'，
-- 门店销售 KPI 只有熊喵，漏品品甜；7月目标 22 是 'ALL' 所以正常）。
-- 修复：① 现网 total 目标回填 'ALL'；② upsert_target_total 默认 'ALL'。
-- 幂等：UPDATE 条件限定 + CREATE OR REPLACE。

-- ===== 1. 现网 total 目标品牌范围回填 ALL（两品牌合计）=====
UPDATE targets SET system_book_code='ALL', updated_at=now()
WHERE target_level='total' AND system_book_code IS DISTINCT FROM 'ALL';

-- ===== 2. upsert_target_total 默认品牌改 'ALL'（原 '3120' 熊喵）=====
CREATE OR REPLACE FUNCTION public.upsert_target_total(
  p_id BIGINT,
  p_name TEXT,
  p_start DATE,
  p_end DATE,
  p_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_id BIGINT;
  v_metrics TEXT[] := ARRAY['outbound_amt', 'outbound_profit', 'sale', 'delivery'];
  m TEXT;
BEGIN
  IF p_end < p_start THEN
    RETURN jsonb_build_object('ok', false, 'error', '周期结束<开始');
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO targets(
      name, system_book_code, branch_num, start_date, end_date,
      status, target_level, target_type, created_by, created_at
    )
    VALUES (
      p_name,
      'ALL',               -- 总目标：全公司两品牌（原 '3120' 只熊喵，漏品品甜）
      'ALL',               -- 总目标：全部门店
      p_start, p_end, 'active', 'total', 'store', p_by, NOW()
    )
    RETURNING id INTO v_id;
  ELSE
    v_id := p_id;
    UPDATE targets
    SET name = p_name, start_date = p_start, end_date = p_end
    WHERE id = v_id AND target_level = 'total';
  END IF;

  FOREACH m IN ARRAY v_metrics
  LOOP
    INSERT INTO target_metric_values (target_id, metric_code, target_value)
    VALUES (v_id, m, 0)
    ON CONFLICT (target_id, metric_code) DO UPDATE SET
      target_value = EXCLUDED.target_value;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'target_id', v_id);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_target_total(BIGINT, TEXT, DATE, DATE, TEXT) TO anon, authenticated, project_admin;

DO $$ BEGIN RAISE NOTICE 'Migration 156: 总目标品牌范围改 ALL（两品牌合计），现网回填'; END $$;

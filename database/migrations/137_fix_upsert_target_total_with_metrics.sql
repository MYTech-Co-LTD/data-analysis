-- 137_fix_upsert_target_total_with_metrics.sql
-- 修复 upsert_target_total：创建目标后自动插入 4 个核心指标的空目标值
-- 这样新建的目标会立即显示在列表中，用户可以点击"分解"进入分解页面

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
  -- 验证日期合理性
  IF p_end < p_start THEN
    RETURN jsonb_build_object('ok', false, 'error', '周期结束<开始');
  END IF;

  -- 创建或更新总目标
  IF p_id IS NULL THEN
    -- 插入新目标
    INSERT INTO targets(
      name,
      system_book_code,
      branch_num,
      start_date,
      end_date,
      status,
      target_level,
      target_type,
      created_by,
      created_at
    )
    VALUES (
      p_name,
      '3120',              -- 默认品牌：熊喵鲜生
      'ALL',               -- 总目标：全部门店
      p_start,
      p_end,
      'active',            -- 状态：生效
      'total',             -- 层级：总目标
      'store',             -- 类型：门店目标
      p_by,
      NOW()
    )
    RETURNING id INTO v_id;
  ELSE
    -- 更新现有目标
    v_id := p_id;
    UPDATE targets
    SET
      name = p_name,
      start_date = p_start,
      end_date = p_end
    WHERE id = v_id AND target_level = 'total';
  END IF;

  -- 插入 4 个核心指标的空目标值（幂等：ON CONFLICT DO UPDATE）
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

-- 授权
GRANT EXECUTE ON FUNCTION public.upsert_target_total(BIGINT, TEXT, DATE, DATE, TEXT) TO anon, authenticated, project_admin;

DO $$ BEGIN RAISE NOTICE 'Migration 137: upsert_target_total 已修复（自动插入 4 个核心指标空目标值）'; END $$;
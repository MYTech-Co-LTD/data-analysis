-- 134_simplify_upsert_target_total.sql
-- 简化 upsert_target_total 函数：仅创建总目标，不写入目标值
-- 目标值在分解阶段写入
-- 删除 p_sbc、p_metrics、p_target_type 参数，使用默认值

-- 使用 OR REPLACE 避免签名冲突（如果旧签名已不存在）
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

  RETURN jsonb_build_object('ok', true, 'target_id', v_id);
END;
$function$;

-- 授权
GRANT EXECUTE ON FUNCTION public.upsert_target_total(BIGINT, TEXT, DATE, DATE, TEXT) TO anon, authenticated, project_admin;
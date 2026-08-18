-- 196：回滚 195——恢复 B1 全维空=deny 语义（用户裁决：195 的「品牌/品类空=不限」
-- 是早前已明确废弃的方案，语义不得擅改；张铎测试场景改用配置修复（测试 permission 补
-- 品牌/品类资源）。本迁移函数体 = 193 版逐字恢复（含 187 会话缓存与 186 归一语义）。

CREATE OR REPLACE FUNCTION public.scope_match_v2(p_dim text, p_col text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_grants JSONB;
  v_gdim   JSONB;
  v_col    TEXT;
  v_last   TEXT;
  v_map    JSONB;
  v_dim_norm JSONB;
  v_gdim_norm JSONB;
  v_allowed TEXT[] := ARRAY['branch_nums','brands','categories'];
BEGIN
  -- claims / x_grants 解析：无 token、非 JSON → fail closed（deny，179/183/186 语义保持）。
  -- ⚠ x_grants 是独立 GUC（request.jwt.claims.x_grants），非 claims JSON 嵌套路径。
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 非法维度名 = deny（防御未知 p_dim）
  IF NOT (p_dim = ANY(v_allowed)) THEN RETURN FALSE; END IF;

  -- 无 data_scope 段（旧形状令牌）→ deny（185 终版语义保持）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NULL THEN RETURN FALSE; END IF;

  v_dim  := v_scope -> p_dim;
  v_gdim := v_grants -> p_dim;
  IF (v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array')
     OR (v_gdim IS NOT NULL AND jsonb_typeof(v_gdim) <> 'array') THEN
    RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义保持）
  END IF;
  IF v_dim IS NULL AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- 维度缺失且无例外 = deny
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);
  IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- 并集空 = authorized ∅ = deny（B1）
  END IF;
  IF v_dim ? '*' OR v_gdim ? '*' THEN
    RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
  END IF;

  -- 186：复合门店键尾段前导零归一（双侧对称；无 '-' 的值原样通过，regexp 不改写）
  v_col := regexp_replace(p_col, '^([0-9]+)-0+([0-9]+)$', '\1-\2');

  -- 会话级缓存：仅当 claims 文本变化时重建归一化数组（jsonb_object_agg 一次算全 3 维）。
  -- current_setting(..., true) 缺省返回 NULL；set_config(..., false)=会话作用域。
  v_last := current_setting('app.sm2_last', true);
  IF v_last IS DISTINCT FROM v_claims::text THEN
    SELECT jsonb_object_agg(d.dim, (
             SELECT jsonb_agg(regexp_replace(e, '^([0-9]+)-0+([0-9]+)$', '\1-\2'))
             FROM jsonb_array_elements_text(coalesce((v_claims -> 'data_scope' -> d.dim), '[]'::jsonb)) e))
      INTO v_map
      FROM unnest(v_allowed) d(dim);
    PERFORM set_config('app.sm2_last', v_claims::text, false);
    PERFORM set_config('app.sm2_map', v_map::text, false);
  ELSE
    v_map := NULLIF(current_setting('app.sm2_map', true), '')::jsonb;
  END IF;

  -- data_scope 侧走缓存（O(1) ? 包含）；x_grants 侧小数组（例外集）内联归一（量级小，免缓存复杂度）
  v_dim_norm := v_map -> p_dim;
  v_gdim_norm := (SELECT jsonb_agg(regexp_replace(e, '^([0-9]+)-0+([0-9]+)$', '\1-\2'))
                  FROM jsonb_array_elements_text(coalesce(v_gdim, '[]'::jsonb)) e);
  IF (v_dim_norm IS NOT NULL AND v_dim_norm ? v_col)
     OR (v_gdim_norm IS NOT NULL AND v_gdim_norm ? v_col) THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$function$;

GRANT EXECUTE ON FUNCTION scope_match_v2(text, text) TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'scope_match_v2') THEN
    RAISE EXCEPTION '196 验证失败：scope_match_v2 不存在';
  END IF;
END $$;

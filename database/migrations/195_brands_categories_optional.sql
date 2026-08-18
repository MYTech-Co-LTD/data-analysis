-- 195：品牌/品类维改为可选细化（空 = 不限制），门店维维持 fail-close（2026-08-18 张铎测试案例）
--
-- 设计语义（用户裁定，2026-08-18 上午再度确认）：门店范围是第一层过滤（必须显式授权，
-- 空 = deny——堵住「漏配即放行」漏洞）；品牌/品类是第二层可选细化（未配置 = 不限制该维，
-- 配了才过滤）。
--
-- 案例：张铎测试配置仅含 范围|东部战区（无任何 品牌|/品类| 资源）→ 旧 B1 三维全 deny →
--       报表数据全空，门店范围根本无法独立生效。
--
-- 改动点（相对 193）：并集空判定分支按维度分派——
--   branch_nums：空 = deny（不变，第一层门禁）
--   brands / categories：空 = 放行（RETURN TRUE，该维不限制；授权清单非空时行为不变）

CREATE OR REPLACE FUNCTION scope_match_v2(p_dim text, p_col text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
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
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 非法维度名 = deny（防御未知 p_dim）
  IF NOT (p_dim = ANY(v_allowed)) THEN RETURN FALSE; END IF;

  -- 旧形状令牌（无 data_scope 段）→ deny（185 终版语义保持；branch 维 fail-close 主门禁）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NULL THEN
    -- 195：brands/categories 无 data_scope 也不能无条件放行（无法证明是「新令牌未配」
    -- 还是「旧令牌」）——统一 deny，保持保守。新令牌 data_scope 三维恒存在（claims.js B1）。
    RETURN FALSE;
  END IF;

  v_dim  := v_scope -> p_dim;
  v_gdim := v_grants -> p_dim;
  IF (v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array')
     OR (v_gdim IS NOT NULL AND jsonb_typeof(v_gdim) <> 'array') THEN
    RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义）
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);
  v_gdim := coalesce(v_gdim, '[]'::jsonb);   -- 195b：无 x_grants GUC 时防 NULL 令空判定短路失效

  -- 195 分维语义：
  IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
    IF p_dim = 'branch_nums' THEN
      RETURN FALSE;                   -- 门店维：空 = authorized ∅ = deny（B1，第一层门禁不变）
    ELSE
      RETURN TRUE;                    -- 品牌/品类维：空 = 未配置 = 不限制（可选细化层）
    END IF;
  END IF;
  IF v_dim ? '*' OR v_gdim ? '*' THEN
    RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
  END IF;

  -- 186：复合门店键尾段前导零归一（双侧对称；无 '-' 的值原样通过，regexp 不改写）
  v_col := regexp_replace(p_col, '^([0-9]+)-0+([0-9]+)$', '\1-\2');

  -- 会话级缓存（187/193）：仅当 claims 文本变化时重建归一化数组
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

  v_dim_norm := v_map -> p_dim;
  v_gdim_norm := (SELECT jsonb_agg(regexp_replace(e, '^([0-9]+)-0+([0-9]+)$', '\1-\2'))
                  FROM jsonb_array_elements_text(coalesce(v_gdim, '[]'::jsonb)) e);
  IF (v_dim_norm IS NOT NULL AND v_dim_norm ? v_col)
     OR (v_gdim_norm IS NOT NULL AND v_gdim_norm ? v_col) THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION scope_match_v2(text, text) TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'scope_match_v2') THEN
    RAISE EXCEPTION '195 验证失败：scope_match_v2 不存在';
  END IF;
END $$;

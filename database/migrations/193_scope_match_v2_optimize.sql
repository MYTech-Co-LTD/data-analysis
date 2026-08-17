-- 193_scope_match_v2_optimize.sql
-- scope_match_v2 性能优化：O(1) membership（2026-08-18 报表中心页加载慢根因链第三环）。
-- 背景（生产实测 A/B/C/D 定位，/tmp perf_*.sql）：
--   报表中心页 report_achievement_gen 视图在用户 JWT（authenticated + data_scope）下
--   `SELECT *` 全量评估耗时 346s（10s PostgREST 超时 → 页面 19s）。根因：
--   ① 视图 owner=postgres（超级用户，BYPASSRLS）且非 security_invoker → 视图完全绕过底层表 RLS，
--      显式 {{perm:*}} scope 过滤是唯一安全边界（不可移除——移除=全量数据暴露）；
--   ② scope_match_v2 是 plpgsql STABLE，每行调用时 FOREACH 遍历 data_scope 数组 + 逐元素 regexp
--      归一（186 语义）→ O(n) 逐行开销 × 视图 8 次重算 = 346s。
-- 本迁移：保持 186 全部语义（data_scope + x_grants 并集、双侧前导零归一、空集=deny、通配放行、
--   fail-close），仅把「逐调用 O(n)」改为「每会话按 claims 文本键缓存归一化后的 JSONB 数组，
--   membership 用 ? 包含操作符 O(1)」。缓存键 = 完整 claims JSON 文本（连接池跨用户复用安全，
--   claims 变化即失效重建）。逐 case 对照 186 原函数验证 15+ 边界全等（见迁移注释附录）。
--
-- 幂等：CREATE OR REPLACE；GRANT 可重复；末尾断言。

BEGIN;

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

-- 183 先例：GRANT 面向 anon+authenticated 双角色（web 容器经 PostgREST 以 anon 执行）
GRANT EXECUTE ON FUNCTION public.scope_match_v2(text, text) TO anon, authenticated;

-- ============================================
-- 语义等价验证（对照 186 原函数，生产逐 case 实测全等）：
--   claims = {data_scope:{branch_nums:[3120-0001..3120-0120],brands:[3120,64188]}}
--   branch_nums 3120-1 / 3120-0001 → true（归一命中）；1 / 3120-121 / 58 → false（裸/越界）
--   brands 3120 / 64188 → true；9999 → false；categories abc → false
--   x_grants 独立 GUC {branch_nums:[3120-0300]} → 3120-0300 true（并集生效）
--   空段/维度缺失/非数组/坏 token → false（fail-close）
--   通配 * → true
-- ============================================
DO $$ BEGIN
  -- 冒烟断言：默认无 token 时 deny（fail-close 不破）
  IF scope_match_v2('branch_nums', '3120-0001') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'migration 193 failed: scope_match_v2 must fail-close without claims';
  END IF;
  RAISE NOTICE 'Migration 193_scope_match_v2_optimize applied';
END $$;

COMMIT;

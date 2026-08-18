-- 197_exception_abolish.sql
-- 例外体系废除（2026-08-18 用户裁定）：数据范围唯一真相 = 范围|X 资源（§6.0/§6.4），无例外通道。
--   · scope_match_v2：删 x_grants 并集分支（v_grants/v_gdim/v_gdim_norm），只认 data_scope 各维
--   · pgrst_pre_request：删 183 的 temporary_grants 实查并集段，恢复 114 纯扁平化版
--   · branch_scope_limited：删 x_grants 读，只认 data_scope.branch_nums
--   · temporary_grants 表保留冻结（历史授权记录），REVOKE 写权限（INSERT/UPDATE 停用）
-- 幂等模板（CLAUDE.md）：CREATE OR REPLACE / IF NOT EXISTS / ON CONFLICT；每次部署重跑安全。

-- 1. scope_match_v2：无 x_grants 分支（B1 空=deny、通配放行、前导零归一、会话缓存语义不变）
CREATE OR REPLACE FUNCTION public.scope_match_v2(p_dim text, p_col text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_col    TEXT;
  v_last   TEXT;
  v_map    JSONB;
  v_dim_norm JSONB;
  v_allowed TEXT[] := ARRAY['branch_nums','brands','categories'];
BEGIN
  -- claims 解析：无 token、非 JSON → fail closed（deny，179/185 语义保持）。例外已废除，无 x_grants。
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 非法维度名 = deny（防御未知 p_dim）
  IF NOT (p_dim = ANY(v_allowed)) THEN RETURN FALSE; END IF;

  -- 无 data_scope 段（旧形状令牌）→ deny（185 终版语义保持）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NULL THEN RETURN FALSE; END IF;

  v_dim := v_scope -> p_dim;
  IF v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array' THEN
    RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义）
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);

  -- B1：空 = authorized ∅ = deny（197 起无例外并集通道，空即空）
  IF jsonb_array_length(v_dim) = 0 THEN
    RETURN FALSE;
  END IF;
  IF v_dim ? '*' THEN
    RETURN TRUE;                      -- 通配 = 放行（语义保留）
  END IF;

  -- 186：复合门店键尾段前导零归一（双侧对称；无 '-' 的值原样通过，regexp 不改写）
  v_col := regexp_replace(p_col, '^([0-9]+)-0+([0-9]+)$', '\1-\2');

  -- 会话级缓存：仅当 claims 文本变化时重建归一化数组（187/193 语义保持）
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
  IF v_dim_norm IS NOT NULL AND v_dim_norm ? v_col THEN
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.scope_match_v2(text, text) TO anon, authenticated;

-- 2. pgrst_pre_request：删 183 例外并集段，恢复 114 纯扁平化版
CREATE OR REPLACE FUNCTION public.pgrst_pre_request() RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw    TEXT;
  v_claims JSONB;
  k TEXT;
  v TEXT;
BEGIN
  v_raw := current_setting('request.jwt.claims', true);
  -- 无 token / anon 请求：claims 为空，不设任何子 GUC
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN;
  END IF;
  BEGIN
    v_claims := v_raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;  -- 非 JSON（异常 token），交给 PostgREST 自身鉴权
  END;
  FOR k, v IN SELECT key, value::text FROM jsonb_each(v_claims) LOOP
    PERFORM set_config('request.jwt.claims.' || k, v, true);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pgrst_pre_request() TO anon, authenticated;
COMMENT ON FUNCTION public.pgrst_pre_request() IS
  'PostgREST pre-request：把 request.jwt.claims JSON 扁平化成 request.jwt.claims.<key> 单个事务级 GUC（197 起例外并集段已废除，恢复 114 纯扁平化版）';

-- 3. branch_scope_limited：删 x_grants 读（194 语义，只认 data_scope.branch_nums）
CREATE OR REPLACE FUNCTION public.branch_scope_limited()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_claims jsonb;
  v_dim jsonb;
BEGIN
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN TRUE;  -- 坏 token = deny（B1）→ 视为受限
  END;

  -- 无 token / 旧形状令牌（无 data_scope 段）= deny → 受限
  IF v_claims IS NULL OR v_claims -> 'data_scope' IS NULL THEN
    RETURN TRUE;
  END IF;

  v_dim := v_claims -> 'data_scope' -> 'branch_nums';
  IF v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array' THEN
    RETURN TRUE;  -- 非数组 = deny
  END IF;

  -- 通配 = 全权 → 不受限（例外已废除，无 x_grants 侧）
  IF COALESCE(v_dim ? '*', false) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.branch_scope_limited() TO anon, authenticated;

-- 4. temporary_grants 冻结：表保留（历史授权记录），REVOKE 写权限停用
REVOKE INSERT, UPDATE ON TABLE public.temporary_grants FROM anon, authenticated;
COMMENT ON TABLE public.temporary_grants IS 'W5 临时例外（已废除 2026-08-18）：例外体系废除，本表冻结保留历史授权记录，不再消费/写入；数据范围唯一真相 = 范围|X 资源';

-- 5. 验证断言（幂等重跑安全）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'scope_match_v2') THEN
    RAISE EXCEPTION '197 验证失败：scope_match_v2 不存在';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'pgrst_pre_request') THEN
    RAISE EXCEPTION '197 验证失败：pgrst_pre_request 不存在';
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'Migration 197: 例外体系废除——scope_match_v2/pgrst_pre_request/branch_scope_limited 去 x_grants，temporary_grants 冻结'; END $$;

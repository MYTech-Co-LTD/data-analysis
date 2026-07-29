-- 114_pgrst_pre_request_flatten_claims.sql
-- 修 PostgREST JWT claim 传播 bug（2026-07-29 实测定位）：
--   PostgREST v12 每请求只设 request.jwt.claims（整个 JSON 串）这一个 GUC，
--   不设 request.jwt.claims.<key>（带点单个 GUC）。而全代码库（032/058/072/107/112/113…）
--   的成本脱敏与 RLS 都读 current_setting('request.jwt.claims.<key>') → 永远 NULL。
--   后果：can_see_cost 恒 false（毛利对全员隐藏）；branch_nums 恒 NULL（RLS IS NULL→放行，门店维度从未收口）。
--
-- 解法：PostgREST pre-request 钩子。每请求前把 JSON 拆成 request.jwt.claims.<key>
--   各个事务级 GUC，旧代码一行不改全部恢复。配 PGRST_DB_PRE_REQUEST=pgrst_pre_request（compose）。
--   set_config(...,true)=事务级，PostgREST 把 pre-request 与主查询包在同一事务，RLS/查询均可见。
-- 幂等：CREATE OR REPLACE FUNCTION；不依赖视图，无需 restart postgrest（仅函数定义）。

CREATE OR REPLACE FUNCTION pgrst_pre_request() RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw    TEXT;
  v_claims JSONB;
  k TEXT;
  v TEXT;
BEGIN
  v_raw := current_setting('request.jwt.claims', true);
  -- 无 token / anon 请求：claims 为空，不设任何子 GUC（现有 IS NULL→放行 兜底行为不变）
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN;
  END IF;
  BEGIN
    v_claims := v_raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;  -- 非 JSON（异常 token），不炸，交给 PostgREST 自身鉴权
  END;
  FOR k, v IN SELECT key, value::text FROM jsonb_each(v_claims) LOOP
    -- value::text：boolean→'true'、数组→'["*"]'、数字→'123'，与旧代码 ::boolean/::jsonb 反序列化兼容
    PERFORM set_config('request.jwt.claims.' || k, v, true);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION pgrst_pre_request() TO anon, authenticated;
COMMENT ON FUNCTION pgrst_pre_request() IS
  'PostgREST pre-request：把 request.jwt.claims JSON 扁平化成 request.jwt.claims.<key> 单个事务级 GUC，修旧代码读带点 GUC 永远 NULL 的 bug（can_see_cost/branch_nums 等）';

DO $$ BEGIN RAISE NOTICE 'Migration 114: pgrst_pre_request() 扁平化 JWT claims（配 PGRST_DB_PRE_REQUEST）'; END $$;

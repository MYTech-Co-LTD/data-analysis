-- database/migrations/132_fix_hq_category_breakdown_permission.sql
-- Grant execute permissions for HQ category breakdown functions
-- These functions are called by PostgREST API endpoints
-- 2026-08-17 幂等守卫化（T10）：旧 3 参签名已被 138 DROP（换 4 参）；migrate.sh 按文件名
-- 全量重跑（132 在 138 前）时裸 GRANT 旧签名 → function does not exist → 管线必挂
-- （main CI failure 31996958965 现场）。改为存在守卫 + 新签名保底授权。

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'upsert_hq_category_breakdown'
      AND pg_get_function_identity_arguments(p.oid) = 'bigint,jsonb,text'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.upsert_hq_category_breakdown(BIGINT, JSONB, TEXT) TO anon, authenticated;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'upsert_hq_category_breakdown'
      AND pg_get_function_identity_arguments(p.oid) = 'bigint,jsonb,text,jsonb'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.upsert_hq_category_breakdown(BIGINT, JSONB, TEXT, JSONB) TO anon, authenticated;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_hq_category_breakdown'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.get_hq_category_breakdown(BIGINT) TO anon, authenticated;
  END IF;
END $$;

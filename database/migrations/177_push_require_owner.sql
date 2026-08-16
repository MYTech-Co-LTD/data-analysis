-- 177_push_require_owner.sql
-- review 修复：web/lib/push/index.ts checkOwnerPermission（run_push 守卫 1）调
--   /rpc/require_push_owner，但此前无任何 migration 定义该 RPC → PostgREST 404 →
--   每次推送都在守卫 1 抛错（引擎整体不可用）。补定义。
--
-- 语义（不变量 2「owner 校验注入」）：
--   - operator 必须是 org_users 中存在的 active 用户；未知/离职 → RAISE（fail-closed，
--     不泄露具体原因，与 get_user_perms_strict 同为 SECURITY DEFINER + 固定 search_path）。
--   - 返回 { paused: boolean } 兼容引擎 data?.paused 读取；真实暂停由守卫 2
--     isPaused()（push_settings 表）负责，此处恒 false（历史兼容，不重复闸）。
--   - 注意：push:configure 是 feature 权限（Casdoor/checkFeaturePerm 管），不在
--     get_user_perms 四维内；DB 层能可靠校验的 owner 语义就是「active 在职用户」。
--     细粒度 feature 闸在 web /api/push 入口已做（B2-B4），本守卫是纵深防御。
-- 幂等：CREATE OR REPLACE FUNCTION / GRANT（重跑安全）。
CREATE OR REPLACE FUNCTION require_push_owner(p_operator_id TEXT)
RETURNS TABLE(paused boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_active BOOLEAN;
BEGIN
  SELECT o.is_active INTO v_active FROM org_users o WHERE o.wecom_id = p_operator_id;
  IF v_active IS NULL OR NOT v_active THEN
    RAISE EXCEPTION 'owner_inactive_or_unknown';
  END IF;
  RETURN QUERY SELECT false::boolean AS paused;
END;
$$;
COMMENT ON FUNCTION require_push_owner(TEXT) IS 'run_push 守卫 1 owner 校验：operator 须为在职 org_users 用户（未知/离职抛异常）；paused 恒 false（真实暂停由 isPaused 守卫）';

GRANT EXECUTE ON FUNCTION require_push_owner(TEXT) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 177_push_require_owner applied'; END $$;
-- 170_get_user_perms_strict.sql
-- M-2 strict wrapper RPC（spec §4.4 fail-open 语义收紧，BLOCKER：arch R2——
--   run_push 等引擎路径复用 fail-open ["*"] 兜底 → 越权渲染）。
--   三态语义：NULL=未知/离职/空基底（fail-close，调用方跳过+审计）；
--             jsonb=有效权限（可能为空集，空集≠NULL，RT-12）。
--   PERMS_INPUT 感知（C2）：读 system_flags('perms_input')，缺省 legacy；
--   不直读镜像、不篡改 get_user_perms 既有语义（委托同一内核，登录路径宽松语义不变）。
--   与 U2 输入源切换分离（单变量纪律）：strict 不消费 PERMS_INPUT 之外的任何开关。
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT ON CONFLICT DO NOTHING / CREATE OR REPLACE。
BEGIN;

-- ① 输入源开关表（Task 13 完整化前先落本表与缺省值）
CREATE TABLE IF NOT EXISTS system_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
COMMENT ON TABLE system_flags IS '平台级开关表（键值对）；perms_input=角色输入源：legacy（role_id 经 roles join 折 code）|casdoor（读 org_users.role_codes 镜像）';

INSERT INTO system_flags(key, value) VALUES ('perms_input', 'legacy')
  ON CONFLICT (key) DO NOTHING;

-- ② strict wrapper：未知/离职 → NULL；空基底（按 PERMS_INPUT 分模式判空）→ NULL；
--    否则委托 get_user_perms（SECURITY DEFINER + 固定 search_path，同 167/168 RPC 模式，
--    调用方（anon/authenticated）无须直读 org_users/data_permissions）。
CREATE OR REPLACE FUNCTION get_user_perms_strict(p_wecom_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_active BOOLEAN;
  v_mode   TEXT;
  v_empty  BOOLEAN;
  v_perms  JSONB;
BEGIN
  -- ① 未知（无行）/离职（is_active=false）→ NULL fail-close，不进宽松内核
  SELECT u.is_active INTO v_active FROM org_users u WHERE u.wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN
    RETURN NULL;
  END IF;

  -- ② PERMS_INPUT 感知判空：空基底 → NULL（封宽松内核空维兜底 ["*"] 的 fail-open 放大）
  SELECT coalesce((SELECT f.value FROM system_flags f WHERE f.key = 'perms_input'), 'legacy')
    INTO v_mode;

  IF v_mode = 'casdoor' THEN
    -- casdoor 模式：镜像空（role_codes='{}' 且从未同步）且无部门基底
    SELECT coalesce(
             (SELECT o.role_codes = '{}' AND o.casdoor_synced_at IS NULL
              FROM org_users o WHERE o.wecom_id = p_wecom_id),
             false)
           AND NOT EXISTS (
             SELECT 1 FROM org_users o
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(o.department_ids) = 'array'
                    THEN o.department_ids ELSE '[]'::jsonb END) AS d(e)
             JOIN data_permissions dp
               ON dp.subject_type = 'dept' AND dp.subject_id::text = d.e
             WHERE o.wecom_id = p_wecom_id
               AND (dp.expires_at IS NULL OR dp.expires_at > NOW()))
      INTO v_empty;
  ELSE
    -- legacy 模式（缺省）：role_id 经 roles join 折 code 后无任何 role 行命中
    --   （沿 168 后的函数语义：active 角色 + 未过期 role 行）且无部门基底
    SELECT NOT EXISTS (
             SELECT 1 FROM org_users o
             JOIN roles r ON r.id = o.role_id AND r.is_active
             JOIN data_permissions dp
               ON dp.subject_type = 'role' AND dp.subject_id = r.code
             WHERE o.wecom_id = p_wecom_id
               AND (dp.expires_at IS NULL OR dp.expires_at > NOW()))
           AND NOT EXISTS (
             SELECT 1 FROM org_users o
             CROSS JOIN LATERAL jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(o.department_ids) = 'array'
                    THEN o.department_ids ELSE '[]'::jsonb END) AS d(e)
             JOIN data_permissions dp
               ON dp.subject_type = 'dept' AND dp.subject_id::text = d.e
             WHERE o.wecom_id = p_wecom_id
               AND (dp.expires_at IS NULL OR dp.expires_at > NOW()))
      INTO v_empty;
  END IF;

  IF v_empty THEN
    RETURN NULL;
  END IF;

  -- ③ 委托宽松内核（登录路径语义不变；不直读镜像、不改既有函数）
  SELECT get_user_perms(p_wecom_id) INTO v_perms;
  RETURN v_perms;
END;
$$;
COMMENT ON FUNCTION get_user_perms_strict(TEXT) IS '引擎路径 strict 权限 RPC：NULL=未知/离职/空基底（fail-close，跳过+审计）；jsonb=有效权限（空集≠NULL）。PERMS_INPUT 感知判空（system_flags，缺省 legacy）；委托 get_user_perms 内核';

GRANT EXECUTE ON FUNCTION get_user_perms_strict(TEXT) TO anon, authenticated;
GRANT SELECT ON system_flags TO anon, authenticated;

COMMIT;

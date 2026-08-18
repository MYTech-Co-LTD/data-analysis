-- database/rollback/175_roles_replay.sql
-- Task 13 回滚 + 回放脚本（U2 切换紧急回滚用）
-- ⚠️ 本文件在 database/rollback/ 目录，【绝不放进 database/migrations/】——
--    migrate.sh 每次部署全量重跑 migrations/，反向脚本入列会把开关每次改回 legacy。
--
-- 做两件事（可独立执行）：
--   ① 回滚：UPDATE system_flags 回 'legacy'（秒级，权限立即走 role_id 路径）
--   ② 回放：Casdoor role_codes → role_id 单向同步（紧急时保证 legacy 路径有数据）
--
-- 用法：
--   只回滚：  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d insforge -f - < database/rollback/175_roles_replay.sql
--   只回放：  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d insforge -c \
--             "DO \$\$ BEGIN PERFORM replay_casdoor_to_legacy(); END \$\$;"
--
-- 回放语义：对每个 active 用户，取 role_codes 数组中第一个 active 角色 → 写入 role_id。
--   仅覆盖 role_source='auto' 用户（manual 用户由 admin 管理，不动）。
--   role_codes 为空 → role_id 置 NULL（安全降级，待 admin 配）。

BEGIN;

-- ① 回滚：system_flags 秒回 legacy
UPDATE system_flags SET value = 'legacy' WHERE key = 'perms_input';
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC（175 回滚态）：system_flags=legacy，走 role_id 路径';

-- ② 回放函数：Casdoor role_codes → legacy role_id（幂等，重跑 no-op）
CREATE OR REPLACE FUNCTION replay_casdoor_to_legacy() RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_updated INT := 0;
  v_nullified INT := 0;
BEGIN
  -- 取每个 active 用户 role_codes 中第一个 active 角色的 id → 写回 role_id
  -- 仅处理 role_source='auto'（manual 不动）
  UPDATE org_users u
  SET role_id = (
    SELECT r.id FROM roles r
    WHERE r.code = ANY(coalesce(u.role_codes, '{}'))
      AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code
    LIMIT 1
  )
  WHERE u.is_active
    AND u.role_source = 'auto'
    AND u.role_codes IS NOT NULL
    AND array_length(u.role_codes, 1) > 0
    AND u.role_id IS DISTINCT FROM (
      SELECT r.id FROM roles r
      WHERE r.code = ANY(u.role_codes)
        AND r.is_active
      ORDER BY r.sort_order NULLS LAST, r.code
      LIMIT 1
    );
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- role_codes 为空的 auto 用户：role_id 置 NULL
  UPDATE org_users u
  SET role_id = NULL
  WHERE u.is_active
    AND u.role_source = 'auto'
    AND (u.role_codes IS NULL OR array_length(u.role_codes, 1) = 0)
    AND u.role_id IS NOT NULL;
  GET DIAGNOSTICS v_nullified = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_updated, 'nullified', v_nullified);
END;
$$;
COMMENT ON FUNCTION replay_casdoor_to_legacy() IS 'U2 回放：Casdoor role_codes → legacy role_id 单向同步（仅 role_source=auto；role_codes 空→NULL）';
GRANT EXECUTE ON replay_casdoor_to_legacy() TO anon, authenticated;

COMMIT;

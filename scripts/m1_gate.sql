-- scripts/m1_gate.sql —— M-1 角色码统一迁移门禁：逐用户 get_user_perms vs 快照 diff=0
-- 用法：psql -v ON_ERROR_STOP=1 -U postgres -d insforge -f scripts/m1_gate.sql
--   （容器内：docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d insforge -f /scripts/m1_gate.sql，
--    本地验证时可 docker cp 或 stdin 重定向；exit 0 = 门禁通过，非零 = 有用户权限 diff）
-- 语义：perm_migration_snapshot 由 168 首跑在键切换前落快照（to_jsonb(get_user_perms(...))）；
--   迁移后重跑本脚本，任何用户四维/UI 字段发生漂移即 WARNING 计数并整体 EXCEPTION。
DO $$
DECLARE uid TEXT; nowv JSONB; snapv JSONB; bad INT := 0;
BEGIN
  IF to_regclass('perm_migration_snapshot') IS NULL THEN
    RAISE EXCEPTION 'snapshot table missing';
  END IF;
  FOR uid, snapv IN SELECT wecom_id, perms FROM perm_migration_snapshot LOOP
    SELECT to_jsonb(get_user_perms(uid)) INTO nowv;
    IF nowv IS DISTINCT FROM snapv THEN bad := bad + 1;
      RAISE WARNING 'DIFF %: snap=% now=%', uid, snapv, nowv; END IF;
  END LOOP;
  IF bad > 0 THEN RAISE EXCEPTION 'm1 gate FAIL: % users differ', bad; END IF;
END $$;

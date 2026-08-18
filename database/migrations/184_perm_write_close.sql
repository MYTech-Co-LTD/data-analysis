-- 184_perm_write_close.sql
-- W5 / H9（Task 18）：data_permissions DB 级写关闭（REVOKE 双层 + 触发器兜底 superuser/psql 直写）。
-- 逃生门 app.bypass_perm_write=on 仅供 database/rollback/167_reverse.sql（Task 20 建）。
-- 幂等 + W6 前瞻：本迁移所有 data_permissions 静态 SQL 包 to_regclass 守卫——Task 20 删表后
-- migrate.sh 重跑本文件仍须全绿（REVOKE/触发器段跳过）。
--
-- 对 plan（Task 18 Step 3）的一处适配（沿用 183 勘误先例）：
-- freeze 两表 REVOKE 独立 DO 块、按自身 to_regclass 守卫，不与 data_permissions 存在性耦合——
-- W6 删 data_permissions 后快照/哨兵仍在回滚窗口内（Task 20 才清理），其禁写须继续生效且可重放。
BEGIN;

-- ① data_permissions 写通道收口（anon = web 容器经 PostgREST 的写角色；authenticated = 用户令牌写通道）
DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON data_permissions FROM anon, authenticated;
  END IF;
END $$;

-- ② review 跟踪项（DW0 review #2，2026-08-16）：pg_default_acl 环境级给新表默认 arwd，
--    快照/哨兵两表 authenticated 实际可 INSERT（180 触发器只封 UPDATE/DELETE）——伪造行污染对账基线。
--    freeze/unfreeze 走 SECURITY DEFINER（函数属主）不受本 REVOKE 影响。
DO $$
BEGIN
  IF to_regclass('public.perm_freeze_snapshot') IS NOT NULL
     AND to_regclass('public.perm_freeze_sentinel') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON perm_freeze_snapshot, perm_freeze_sentinel FROM anon, authenticated;
  END IF;
END $$;

-- ③ 触发器兜底（REVOKE 只封 anon/authenticated；superuser/psql 直写与 pg_default_acl 漏网由本层拦）
CREATE OR REPLACE FUNCTION forbid_dp_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.bypass_perm_write', true) = 'on' THEN
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;   -- 逃生门（回滚脚本）
  END IF;
  RAISE EXCEPTION 'data_permissions frozen (W5 写关闭, spec 2026-08-16 §5.2): 授权走 Casdoor; 例外走 temporary_grants; 回滚用 database/rollback/167_reverse.sql';
END; $$;

DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_dp_write_close ON data_permissions;
    CREATE TRIGGER trg_dp_write_close BEFORE INSERT OR UPDATE OR DELETE ON data_permissions
      FOR EACH ROW EXECUTE FUNCTION forbid_dp_write();
  END IF;
END $$;

COMMIT;

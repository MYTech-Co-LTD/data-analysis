-- Casdoor 复用现有 postgres:建独立 casdoor 角色(免新增数据库容器)
-- casdoor_pw 是 Casdoor 专用密码,与业务 postgres 密码解耦,dev/生产统一。
-- 幂等:dev/生产各跑一次 ——
--   docker exec deploy-postgres-1 psql -U postgres -f deploy/casdoor/init-role.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'casdoor') THEN
    CREATE ROLE casdoor LOGIN CREATEDB PASSWORD 'casdoor_pw';
  ELSE
    ALTER ROLE casdoor WITH LOGIN CREATEDB PASSWORD 'casdoor_pw';
  END IF;
END
$$;

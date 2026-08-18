-- 199_scope_resources_projection.sql
-- 数据范围持久投影（方案 A）：Casdoor 角色链可达的范围资源键（归一化形态：
--   data-analysis:branch:X（X=范围|后原值）/ data-analysis:brand:* / category:* / field:*）。
-- 无会话链路（run_push/agent-query/preview）经 get_user_perms 解析 data_scope 的唯一输入。
-- 非真相源，只被写穿（登录/薄同步/对账）。
-- 幂等：ADD COLUMN IF NOT EXISTS，重跑 no-op（migrate.sh 每次部署重跑全部迁移）。
BEGIN;

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS scope_resources TEXT[] DEFAULT '{}';

COMMENT ON COLUMN org_users.scope_resources IS
  '数据范围资源键持久投影（方案 A）：Casdoor 角色链可达的范围相关资源键（归一化形态：data-analysis:branch:X / brand:* / category:* / field:*）；无会话链路经 get_user_perms 解析 data_scope 的唯一输入。非真相源，只被写穿（登录/薄同步/对账）。';

COMMIT;

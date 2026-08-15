-- 169_org_users_role_mirror.sql
-- M-2 Casdoor 角色镜像列（spec 2026-08-15 平台级权限改造 §4.2 镜像表，P0a 只加列不删列）：
--   org_users 加 role_codes / casdoor_writer / casdoor_synced 三列（run_push 等
--   无会话路径的物理载体，也是「Casdoor 宕机数据面不受影响」的载体）。
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，重跑 no-op。
-- 明确不执行：DROP COLUMN role_id（U2 前回滚路径 + shadow 基线双保障，U2 验收后按 sunset 删）。
BEGIN;

ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_codes TEXT[] DEFAULT '{}';
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_writer VARCHAR(10) DEFAULT 'auto';  -- auto|manual（C3：新语义载体，不复用 152 的 role_source）
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS casdoor_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN org_users.role_codes IS 'Casdoor 角色码镜像（持久投影，非真相源；写穿三径：登录/薄同步/对账回写；U2 起为 get_user_perms 的角色输入源）';
COMMENT ON COLUMN org_users.casdoor_writer IS '写者标记：auto=dept_role_mapping 推导写 Casdoor；manual=Casdoor UI 人工→薄同步写豁免（防手工配置橡皮擦）';
COMMENT ON COLUMN org_users.casdoor_synced_at IS '镜像最近一次同步时间；NULL=从未同步（strict 判空输入之一）';

CREATE INDEX IF NOT EXISTS idx_org_users_active ON org_users(is_active);

COMMIT;

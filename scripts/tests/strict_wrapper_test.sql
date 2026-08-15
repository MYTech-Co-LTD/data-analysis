-- scripts/tests/strict_wrapper_test.sql
-- M-2 get_user_perms_strict 失败测试（plan Task 2 Step 1 代码为基）+ PERMS_INPUT 感知补测。
-- 运行：scratch 库应用核心链（001/016/017/072/152/167/168 + 169 + 170）后
--   psql -v ON_ERROR_STOP=1 -f scripts/tests/strict_wrapper_test.sql
-- 断言（三态语义：NULL=未知/离职/空基底 fail-close；jsonb=有效权限，可能为空集≠NULL）：
--   ① 未知用户 → NULL
--   ② 在职但无角色行且无部门基底（legacy 判空）→ NULL（封 fail-open ["*"] 兜底，BLOCKER arch R2）
--   ③ is_active=false（离职）→ NULL
--   ④ 有基底在职用户 → jsonb 非 NULL 且含四维键（空集≠NULL）
--   ⑤ PERMS_INPUT=casdoor：镜像空且无部门基底 → NULL；部门基底仍在 → 非 NULL
-- 事务内造数，ROLLBACK 清理。
\set ON_ERROR_STOP on
BEGIN;

-- 造数：无基底用户 + 有基底用户（角色+部门）
INSERT INTO org_users(wecom_id, name, is_active) VALUES ('__t_strict_user', 't-nobase', true)
  ON CONFLICT DO NOTHING;

INSERT INTO roles(code, name, is_active) VALUES ('__t_strict_role', 't-role', true)
  ON CONFLICT DO NOTHING;
INSERT INTO org_departments(id, name, is_active) VALUES ('__t_strict_dept', 't-dept', true)
  ON CONFLICT DO NOTHING;
INSERT INTO data_permissions(subject_type, subject_id, branch_nums, brands, categories, can_see_cost)
VALUES ('role', '__t_strict_role', '["0001"]'::jsonb, '["3120"]'::jsonb, '["fruit"]'::jsonb, true),
       ('dept', '__t_strict_dept', '["0002"]'::jsonb, NULL, NULL, NULL);
INSERT INTO org_users(wecom_id, name, is_active, role_id, department_ids)
VALUES ('__t_strict_full_user', 't-full', true,
        (SELECT id FROM roles WHERE code='__t_strict_role'),
        '["__t_strict_dept"]'::jsonb)
  ON CONFLICT DO NOTHING;

-- ① 未知用户 → NULL
DO $$ BEGIN
  IF get_user_perms_strict('__no_such_user__') IS NOT NULL THEN
    RAISE EXCEPTION 'assert1 failed: unknown user must be NULL'; END IF; END $$;

-- ② 在职无基底（legacy 判空：无 role 行命中且无部门基底）→ NULL
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_user') IS NOT NULL THEN
    RAISE EXCEPTION 'assert2 failed: legacy empty-base active user must be NULL'; END IF; END $$;

-- ③ is_active=false（离职）→ NULL
UPDATE org_users SET is_active=false WHERE wecom_id='__t_strict_user';
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_user') IS NOT NULL THEN
    RAISE EXCEPTION 'assert3 failed: inactive user must be NULL'; END IF; END $$;

-- ④ 有基底在职用户 → jsonb 非 NULL（空集≠NULL 三态），且为含四维键的对象
DO $$ DECLARE v JSONB; BEGIN
  v := get_user_perms_strict('__t_strict_full_user');
  IF v IS NULL THEN RAISE EXCEPTION 'assert4 failed: based user must be non-NULL'; END IF;
  IF jsonb_typeof(v) <> 'object' OR NOT (v ? 'branch_nums' AND v ? 'brands'
     AND v ? 'categories' AND v ? 'can_see_cost') THEN
    RAISE EXCEPTION 'assert4 failed: unexpected payload %', v; END IF; END $$;

-- ⑤ PERMS_INPUT 感知：casdoor 模式下「镜像空(role_codes={} 且未同步)且无部门基底」→ NULL；
--    部门基底仍在的用户不受影响。
UPDATE system_flags SET value='casdoor' WHERE key='perms_input';
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_full_user') IS NULL THEN
    RAISE EXCEPTION 'assert5 failed: dept-based user must survive casdoor mode'; END IF; END $$;
UPDATE org_users SET role_id=NULL WHERE wecom_id='__t_strict_full_user';  -- 去角色基底，仅余部门
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_full_user') IS NULL THEN
    RAISE EXCEPTION 'assert5 failed: dept base alone must survive casdoor mode'; END IF; END $$;
UPDATE org_users SET department_ids=NULL WHERE wecom_id='__t_strict_full_user';  -- 镜像空+无基底
DO $$ BEGIN
  IF get_user_perms_strict('__t_strict_full_user') IS NOT NULL THEN
    RAISE EXCEPTION 'assert5 failed: casdoor empty-mirror no-base user must be NULL'; END IF; END $$;
UPDATE system_flags SET value='legacy' WHERE key='perms_input';

ROLLBACK;

-- database/tests/200_get_user_perms_scope_resources.sql
-- M13（spec-forge）：get_user_perms 双形分支测试入库，防函数一改测试失联。
-- 覆盖：全店短路 / collapseFullStore 收敛（拆两用例）/ 双形同源 / 分区包 / 未知键 fail-close /
--       空集 deny / 中文名唯一命中 / 中文名重名 fail-close / NOT FOUND 分流（system:% 宽松 + 真实用户 deny）/
--       strict 闸正反例（M11：NULL = 无 role_codes ∧ 无 scope_resources）。
--
-- 用法（迁移 199+200 已应用之后，幂等可重复跑）：
--   docker exec -i deploy-postgres-1 psql -U postgres -d insforge -v ON_ERROR_STOP=1 -f database/tests/200_get_user_perms_scope_resources.sql
--
-- fixture 设计（与真实数据 3120/64188 前缀隔离）：
--   · maps_branch_group：分区包 ZZTEST分区A = 3 店（0101/0102/0103）+ 游离店 ZZTEST-0199 ——
--     universe=4 > 包大小=3，使分区包用例不会意外触发 collapseFullStore 收敛（结果集<universe → 保明细）。
--   · dim_branch：中文名唯一（ZZ测试门店甲→ZZTEST-0201）/ 重名对（ZZ测试门店重名 ×2 → 0202/0203）；
--     branch_number 为 GENERATED（sbc||'-'||LPAD(branch_num,4,'0')）；三店均不在 maps universe。
--   · 用户：zz_test_*；scope_resources 投影键形如 data-analysis:branch:X / brand:* / field:*。
--
-- ★ 空分区包（M7 coalesce）不可构造性说明：
--   maps_branch_group.branch_number 为 NOT NULL，active 组必有 ≥1 branch_number → 函数内
--   array_agg(...) 的 v_tmp 恒非 NULL；M7 的 coalesce 是防未来 schema 放宽 NOT NULL 的防御代码
--   （PostgreSQL `||` 把 NULL 数组当空数组，但 NULL||NULL 仍为 NULL，空包首键时毒化整列），
--   当前 schema 下无数据路径可触发，故本文件不构造该分支。
--
-- 幂等：fixture INSERT 均 ON CONFLICT；尾部 DELETE 清理；事务包裹——中途断言失败（RAISE EXCEPTION +
-- ON_ERROR_STOP）连接关闭 → 隐式回滚，无残留。
\set ON_ERROR_STOP on
BEGIN;

-- ═══════════════════ fixture 准备 ═══════════════════
INSERT INTO maps_branch_group (branch_number, group_id, group_name, group_type, is_active, source) VALUES
  ('ZZTEST-0101', 'ZZTEST分区A', 'ZZ测试分区A', 'dept',   true, 'manual'),
  ('ZZTEST-0102', 'ZZTEST分区A', 'ZZ测试分区A', 'dept',   true, 'manual'),
  ('ZZTEST-0103', 'ZZTEST分区A', 'ZZ测试分区A', 'dept',   true, 'manual'),
  ('ZZTEST-0199', 'ZZTEST其他',  'ZZ测试其他',  'store',  true, 'manual')
ON CONFLICT (group_id, branch_number) DO UPDATE SET
  group_name=EXCLUDED.group_name, group_type=EXCLUDED.group_type, is_active=true, source=EXCLUDED.source;

INSERT INTO dim_branch (system_book_code, branch_num, branch_name, is_active) VALUES
  ('ZZTEST', '0201', 'ZZ测试门店甲',   true),
  ('ZZTEST', '0202', 'ZZ测试门店重名', true),
  ('ZZTEST', '0203', 'ZZ测试门店重名', true)
ON CONFLICT (system_book_code, branch_num) DO UPDATE SET
  branch_name=EXCLUDED.branch_name, is_active=true;

INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_full',   'zz测试', true, '{boss}', ARRAY['data-analysis:branch:全店','data-analysis:brand:3120','data-analysis:field:cost'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_zone',   'zz测试', true, '{}', ARRAY['data-analysis:branch:ZZTEST分区A'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_unknown','zz测试', true, '{}', ARRAY['data-analysis:branch:不存在的包'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_none',   'zz测试', true, '{}', ARRAY[]::text[])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_name',   'zz测试', true, '{}', ARRAY['data-analysis:branch:ZZ测试门店甲'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;
INSERT INTO org_users (wecom_id, name, is_active, role_codes, scope_resources) VALUES
  ('zz_test_ambig',  'zz测试', true, '{}', ARRAY['data-analysis:branch:ZZ测试门店重名'])
ON CONFLICT (wecom_id) DO UPDATE SET is_active=true, role_codes=EXCLUDED.role_codes, scope_resources=EXCLUDED.scope_resources;

-- ═══════════════════ 分支断言 ═══════════════════
-- 分支1a：全店键短路 → ['*']（唯一合法通配，M2）+ brands/cost 前缀剥离
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_full') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '["*"]'::jsonb) THEN
    RAISE EXCEPTION 'T1a 全店短路失败: %', p->'data_scope'->'branch_nums';
  END IF;
  IF NOT (p->'data_scope'->'brands' = '["3120"]'::jsonb) THEN
    RAISE EXCEPTION 'T1a brands 解析失败: %', p->'data_scope'->'brands';
  END IF;
  IF NOT (p->'fields'->'cost' = 'true'::jsonb) THEN
    RAISE EXCEPTION 'T1a field:cost 解析失败: %', p->'fields'->'cost';
  END IF;
END $$;

-- 分支1b：显式全量 branch_number（当前 universe 动态，含 real+fixture）→ collapseFullStore 收敛 ['*']
--   （走到 v_universe_size/v_result_size 代码路径，而非通配短路；集合相等才收敛）
UPDATE org_users SET scope_resources = ARRAY(
  SELECT DISTINCT 'data-analysis:branch:' || branch_number
  FROM maps_branch_group WHERE is_active AND branch_number IS NOT NULL
) WHERE wecom_id = 'zz_test_full';
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_full') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '["*"]'::jsonb) THEN
    RAISE EXCEPTION 'T1b collapseFullStore 收敛失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支1c：双形同源——旧顶层四维 == 新 data_scope/fields
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_full') INTO p;
  IF NOT (p->'branch_nums' = p->'data_scope'->'branch_nums'
      AND p->'brands' = p->'data_scope'->'brands'
      AND p->'categories' = p->'data_scope'->'categories'
      AND p->'can_see_cost' = p->'fields'->'cost') THEN
    RAISE EXCEPTION 'T1c 双形同源失败: branch_nums=% data_scope=%', p->'branch_nums', p->'data_scope';
  END IF;
END $$;

-- 分支2：分区包展开（ZZTEST分区A → 3 店；universe=4 防误收敛）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_zone') INTO p;
  IF NOT (jsonb_array_length(p->'data_scope'->'branch_nums') = 3
      AND p->'data_scope'->'branch_nums' @> '["ZZTEST-0101","ZZTEST-0102","ZZTEST-0103"]'::jsonb) THEN
    RAISE EXCEPTION 'T2 分区包展开失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支3：未知键 fail-close → []（B1，防手误配错包放行）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_unknown') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '[]'::jsonb) THEN
    RAISE EXCEPTION 'T3 未知键 fail-close 失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支4：空资源 → 空集 deny（B1，禁收敛 ['*']）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_none') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '[]'::jsonb) THEN
    RAISE EXCEPTION 'T4 空集 deny 失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支5：中文名唯一命中（dim_branch 单命中 → GENERATED branch_number）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_name') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '["ZZTEST-0201"]'::jsonb) THEN
    RAISE EXCEPTION 'T5 中文名唯一命中失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支6：中文名重名 → fail-close []（歧义=不确定，禁放行）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('zz_test_ambig') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '[]'::jsonb) THEN
    RAISE EXCEPTION 'T6 中文名重名 fail-close 失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- 分支7：NOT FOUND 分流（189 语义 + data_scope/fields 同源）——system:% 服务身份宽松；真实不存在用户 deny
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms('system:zz_test_nonexistent') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '["*"]'::jsonb) THEN
    RAISE EXCEPTION 'T7 system 服务身份宽松失败: %', p->'data_scope'->'branch_nums';
  END IF;
  SELECT get_user_perms('zz_test_nobody_zz') INTO p;
  IF NOT (p->'data_scope'->'branch_nums' = '[]'::jsonb) THEN
    RAISE EXCEPTION 'T7 真实用户 deny 失败: %', p->'data_scope'->'branch_nums';
  END IF;
END $$;

-- ═══════════════════ strict 闸（M11）═══════════════════
-- S1 反例：无 role_codes ∧ 无 scope_resources → NULL fail-close
UPDATE org_users SET role_codes='{}', scope_resources=ARRAY[]::text[] WHERE wecom_id='zz_test_none';
DO $$
BEGIN
  IF get_user_perms_strict('zz_test_none') IS NOT NULL THEN
    RAISE EXCEPTION 'S1 strict 空基底应 NULL';
  END IF;
END $$;
-- S2 正例：仅 role_codes 有值 → 非 NULL（委托内核）
UPDATE org_users SET role_codes='{boss}' WHERE wecom_id='zz_test_none';
DO $$
BEGIN
  IF get_user_perms_strict('zz_test_none') IS NULL THEN
    RAISE EXCEPTION 'S2 strict 仅 role_codes 应非 NULL';
  END IF;
END $$;
-- S3 正例：仅 scope_resources 有值 → 非 NULL
UPDATE org_users SET role_codes='{}', scope_resources=ARRAY['data-analysis:branch:全店'] WHERE wecom_id='zz_test_none';
DO $$
BEGIN
  IF get_user_perms_strict('zz_test_none') IS NULL THEN
    RAISE EXCEPTION 'S3 strict 仅 scope_resources 应非 NULL';
  END IF;
END $$;
-- S4 反例：未知/离职用户 → NULL
DO $$
BEGIN
  IF get_user_perms_strict('zz_test_nobody_zz') IS NOT NULL THEN
    RAISE EXCEPTION 'S4 strict 未知用户应 NULL';
  END IF;
END $$;
-- S5 正例：委托内核输出含 data_scope/fields（双形）
DO $$
DECLARE p jsonb;
BEGIN
  SELECT get_user_perms_strict('zz_test_full') INTO p;
  IF p IS NULL OR p->'data_scope' IS NULL OR p->'fields' IS NULL THEN
    RAISE EXCEPTION 'S5 strict 委托输出缺 data_scope/fields';
  END IF;
END $$;

-- ═══════════════════ 清理（幂等；事务内，失败自动回滚无残留）═══════════════════
DELETE FROM org_users WHERE wecom_id LIKE 'zz_test%';
DELETE FROM maps_branch_group WHERE group_id LIKE 'ZZTEST%' OR branch_number LIKE 'ZZTEST-%';
DELETE FROM dim_branch WHERE system_book_code = 'ZZTEST';
COMMIT;

DO $$ BEGIN RAISE NOTICE 'test 200_get_user_perms_scope_resources: ALL BRANCHES PASSED'; END $$;

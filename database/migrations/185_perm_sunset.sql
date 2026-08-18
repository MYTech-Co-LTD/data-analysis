-- 185_perm_sunset.sql
-- W6 / B6+H11+H9 收口：data_permissions 删除（双氧期结束）。前置 = W5 退出判据全绿。
-- 终版函数替换（每部署 179/182/183 重跑建过渡版 → 185 终版胜出——migrate.sh 全量重跑序保证；
--  072 每部署 CREATE OR REPLACE claim_match_or_star → 本迁移序后 DROP，终态恒「已删」）。
--
-- ⚠️ 与 plan（Task 20 Step 3）的五处适配（沿用 180/183/184 迁移头勘误先例，取证见 task20 report）：
--  ① §③ perms_input 钉死：plan 原文 `UPDATE ... AND NOT EXISTS (SELECT 1 FROM data_permissions)`
--     双重不成立——行存在（冻结期恒 6 行）→ 永不钉死；表删后二跑 → relation 报错非幂等。
--     改 to_regclass 守卫 DO 块（表不在才钉）+ 同位落 data_permissions_sunset 旗标
--     （perm-shadow job 读旗标 no-op，W6 后夜任务不空转写 ERROR 行）；
--  ② system_flags 无 updated_at 列（170 DDL 仅 key/value），plan 版 SET updated_at 会报错——删；
--  ③ claim_match_or_star 真实签名 (jsonb,text) 非 (text,text)；shadow 副本真实签名
--     (character varying) 非 (text)（175 自身 DROP (TEXT) 恒 miss 的同源事实）；
--  ④ 残留清点（pg_proc prosrc LIKE '%data_permissions%'）命中 7 函数，超出 plan 所列——
--     get_user_perms/strict 按 plan 重建 casdoor-only；shadow 双副本 DROP（双氧期结束）；
--     freeze_perms 落 sunset 桩（禁模糊 relation 错误）；unfreeze_perms/forbid_dp_write 不触表不改动；
--  ⑤ get_user_perms casdoor-only 数据源（plan 未拼写）：branch_nums = org_users.groups（F9 投影，
--     178 注释明示「无会话路径（run_push/agent-query）读门店行的唯一入口」）× maps_branch_group 展开
--     （store 直映 + region 前缀子孙 + dept 不贡献 + 未知组 fail-close，与 callback
--     expandGroupsToBranches 同语义）；brands/categories DB 无 Casdoor 资源镜像 → 空数组
--     （deny 方向，权威源=登录 claims data_scope）；can_see_cost = temporary_grants 例外通道实查。
--     宽松内核的「空数组→["*"]」fail-open 兜底随表删除（B1 空集=deny）；未知用户 NOT FOUND
--     分支维持现状 ["*"]（system:cron 服务身份语义，非本次行为变更面）。
BEGIN;

-- ============================================
-- ① scope_match_v2 终版（= 183 并集版 − legacy 回退支；B1 全量生效）
--    data_scope 段缺失（旧形状令牌）→ 直接 deny（S4 豁免窗口关闭，072 宽松支唯一入口摘除）
-- ============================================
CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_grants JSONB;
  v_gdim   JSONB;
  v_val    TEXT;
BEGIN
  -- claims / x_grants 解析：无 token、非 JSON → fail closed（deny，179/183 语义保持）
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- ★终版：无 data_scope 段（旧形状令牌）不再回退 072——deny（S4 豁免窗口关闭，185）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NULL THEN
    RETURN FALSE;
  END IF;

  v_dim  := v_scope -> p_dim;
  v_gdim := coalesce(v_grants -> p_dim, '[]'::jsonb);
  IF (v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array')
     OR (v_gdim IS NOT NULL AND jsonb_typeof(v_gdim) <> 'array') THEN
    RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义保持）
  END IF;
  IF v_dim IS NULL AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- 维度缺失且无例外 = deny（禁回退——形状已判新）
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);
  IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- ★并集空 = authorized ∅ = deny（B1）
  END IF;
  IF v_dim ? '*' OR v_gdim ? '*' THEN
    RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
  END IF;
  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
    IF v_val = p_col THEN RETURN TRUE; END IF;
  END LOOP;
  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_gdim)) LOOP
    IF v_val = p_col THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION scope_match_v2 IS
  'W6 终版：data_scope.<dim> ∪ x_grants.<dim>；并集空=deny（B1）、通配任一侧放行；无 data_scope 段（旧形状令牌）= deny（S4 窗口已关，185 摘 legacy 回退支）';

GRANT EXECUTE ON FUNCTION scope_match_v2(TEXT, TEXT) TO anon, authenticated;

-- ============================================
-- ② can_cost_visible 终版：只认 fields.cost（摘 can_see_cost 旧 key 回退，B6）
-- ============================================
CREATE OR REPLACE FUNCTION can_cost_visible()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_fields JSONB;
BEGIN
  v_fields := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'fields';
  RETURN coalesce((v_fields->>'cost')::boolean, false);   -- 无 fields 段/缺 key = 全掩（安全方向）
END; $$;
GRANT EXECUTE ON FUNCTION can_cost_visible TO anon, authenticated;

COMMENT ON FUNCTION can_cost_visible IS 'W6 终版列掩码判定：唯一源 claims.fields.cost（185 摘 can_see_cost 顶层回退；无 fields 段 = 全掩）';

-- ============================================
-- ③ get_user_perms 终版（casdoor-only，无 data_permissions 依赖）
--    消费方：wecom-oidc-callback（H5 字段）、agent-query（branch_nums/can_see_cost）、
--    get_user_perms_strict（委托）、管理页 preview（排障展示）。数据源见文件头适配⑤。
-- ============================================
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dept_ids JSONB;
  v_role_codes TEXT[];
  v_groups JSONB;
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_branch JSONB;
  v_cost BOOLEAN;
BEGIN
  SELECT u.department_ids, coalesce(u.role_codes, '{}'), u.groups
    INTO v_dept_ids, v_role_codes, v_groups
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    -- 未知用户（system:cron 等服务身份）：现状宽松形状保留（非本次行为变更面；改动须独立 task）
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  -- 1) 角色 UI 档案：role_codes 中 sort_order 最小的 active 角色（175 casdoor 分支同款）
  IF array_length(v_role_codes, 1) > 0 THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r
    WHERE r.code = ANY(v_role_codes) AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code
    LIMIT 1;
  END IF;

  -- 2) branch_nums：groups 投影（F9）× maps_branch_group 展开——
  --    与 callback resolveGroupBranches 同语义（2026-08-17 组树迁移企微部门树后）：
  --    新形态（部门组）：group_id=部门名 × branch_number 多行，任一命中行即贡献（战区/区部门→
  --    辖区门店多行；职能部门→全店 388 行，group_type 不再区分）；旧形态兼容（门店组过渡）：
  --    store 前缀子孙并集；未知组 fail-close（整单清空）/ 无组 = []（deny，B1）
  WITH gs AS (
    SELECT DISTINCT split_part(g, '/', array_length(string_to_array(g, '/'), 1)) AS name
    FROM jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(v_groups) = 'array' THEN v_groups ELSE '[]'::jsonb END) AS g
  ),
  unknown AS (
    SELECT 1 FROM gs l
    WHERE NOT EXISTS (SELECT 1 FROM maps_branch_group m WHERE m.is_active AND m.group_id = l.name)
      AND NOT EXISTS (SELECT 1 FROM maps_branch_group m WHERE m.is_active AND starts_with(m.group_id, l.name || '-'))
  ),
  branch AS (
    SELECT DISTINCT m.branch_number
    FROM maps_branch_group m CROSS JOIN gs l
    WHERE m.is_active AND m.branch_number IS NOT NULL
      AND (m.group_id = l.name OR (m.group_type = 'store' AND starts_with(m.group_id, l.name || '-')))
  )
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM unknown) THEN '[]'::jsonb
    ELSE coalesce((SELECT jsonb_agg(branch_number ORDER BY branch_number) FROM branch), '[]'::jsonb)
  END INTO v_branch;

  -- 3) can_see_cost：temporary_grants 例外通道（fields/cost）实查；
  --    主通道 data-analysis:field:cost 在 Casdoor 资源侧（登录 claims fields.cost），DB 无镜像。
  SELECT EXISTS (
    SELECT 1 FROM temporary_grants tg
    WHERE tg.user_id = p_wecom_id AND tg.dim = 'fields' AND tg.value = 'cost'
      AND tg.revoked_at IS NULL AND tg.expires_at > now()
  ) INTO v_cost;

  -- 4) brands/categories：DB 无 Casdoor 资源镜像 → 空数组（deny 方向；权威源 = 登录 claims data_scope）
  RETURN jsonb_build_object('role_code', v_role_code, 'branch_nums', v_branch,
    'brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'can_see_cost', v_cost,
    'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels);
END;
$$;
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC（185 casdoor-only 终版）：角色 UI=roles×role_codes；branch_nums=groups(F9)×maps_branch_group 展开；can_see_cost=temporary_grants 例外；brands/categories=[]（权威源=登录 claims data_scope）';
GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;

-- ③b get_user_perms_strict 终版（casdoor-only 判空）：NULL=未知/离职/空基底（无角色镜像+无组+无活跃例外）
CREATE OR REPLACE FUNCTION get_user_perms_strict(p_wecom_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_active BOOLEAN;
  v_empty  BOOLEAN;
  v_perms  JSONB;
BEGIN
  -- ① 未知（无行）/离职（is_active=false）→ NULL fail-close（170 语义不变）
  SELECT u.is_active INTO v_active FROM org_users u WHERE u.wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN
    RETURN NULL;
  END IF;

  -- ② 空基底判定（casdoor-only）：无 role_codes 镜像 ∧ 无 groups 投影 ∧ 无活跃 temporary_grants
  --    → NULL（三源全空 = 零授权面；C2 下 groups 空者登录本就不通）
  SELECT coalesce(array_length(o.role_codes, 1), 0) = 0
         AND o.groups = '[]'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM temporary_grants tg
           WHERE tg.user_id = p_wecom_id AND tg.revoked_at IS NULL AND tg.expires_at > now())
    INTO v_empty
  FROM org_users o WHERE o.wecom_id = p_wecom_id;
  IF coalesce(v_empty, true) THEN
    RETURN NULL;
  END IF;

  -- ③ 委托终版内核
  SELECT get_user_perms(p_wecom_id) INTO v_perms;
  RETURN v_perms;
END;
$$;
COMMENT ON FUNCTION get_user_perms_strict(TEXT) IS '引擎路径 strict 权限 RPC（185 casdoor-only 终版）：NULL=未知/离职/空基底（无角色镜像+无组+无活跃例外）；否则委托 get_user_perms';
GRANT EXECUTE ON FUNCTION get_user_perms_strict(TEXT) TO anon, authenticated;

-- ③c freeze_perms sunset 桩：表在（演练/回滚窗口）= 180 原逻辑；表不在 = 明确引导错误
--     （plpgsql 体不随 DROP 校验，180 每部署重跑会重建出引用已删表的函数体——本桩序后胜出）
CREATE OR REPLACE FUNCTION freeze_perms()
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t TIMESTAMPTZ := now() AT TIME ZONE 'UTC';
BEGIN
  IF to_regclass('public.data_permissions') IS NULL THEN
    RAISE EXCEPTION 'data_permissions sunset (W6, 迁移185): 冻结窗口已结束; 回滚/演练见 database/rollback/167_reverse.sql';
  END IF;
  INSERT INTO perm_freeze_sentinel(key, frozen_at) VALUES ('data_permissions_frozen', t)
  ON CONFLICT (key) DO NOTHING;
  INSERT INTO perm_freeze_snapshot(subject_type, subject_id, brands, categories, branch_nums, can_see_cost)
  SELECT subject_type, subject_id,
         coalesce(brands, '[]'::jsonb), coalesce(categories, '[]'::jsonb),
         coalesce(branch_nums, '[]'::jsonb), coalesce(can_see_cost, false)
  FROM data_permissions
  ON CONFLICT (subject_type, subject_id) DO NOTHING;
  RETURN (SELECT frozen_at FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen');
END; $$;

-- ④ sunset 本体：shadow 双副本（双氧期结束）→ 函数摘除 → 表删除
--    执行前清点（人工核对清单）：SELECT proname FROM pg_proc WHERE prosrc LIKE '%data_permissions%';
--    残留处理：get_user_perms/strict=③ 重建；legacy/casdoor=本处 DROP；freeze/unfreeze=③c 桩/不触表；
--    forbid_dp_write=触发器随表删、184 守卫已跳过重建。
DROP FUNCTION IF EXISTS get_user_perms_legacy(character varying);
DROP FUNCTION IF EXISTS get_user_perms_casdoor(character varying);
-- CASCADE：生产首跑时旧版 report_*_gen 视图仍引用本函数（generated 在迁移之后才重建），
-- 无 CASCADE 会被依赖挡住使 migrate 中断；视图随后由 database/generated/*.sql 重建为新版（scope_match_v2）。
DROP FUNCTION IF EXISTS claim_match_or_star(jsonb, text) CASCADE;
DROP TABLE IF EXISTS data_permissions;

-- ⑤ 输入开关钉死 + sunset 旗标（表不在才执行——演练/回滚窗口表在时不强制；
--    167_reverse 回滚时 DELETE 旗标行恢复 job 常态）
DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NULL THEN
    UPDATE system_flags SET value = 'casdoor' WHERE key = 'perms_input';
    INSERT INTO system_flags(key, value) VALUES ('data_permissions_sunset', 'done')
    ON CONFLICT (key) DO NOTHING;
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'Migration 185: data_permissions sunset（终版函数已胜出，双氧期结束）'; END $$;

COMMIT;

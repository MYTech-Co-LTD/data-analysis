-- 175_get_user_perms_input_switch.sql
-- Task 13: U2 登录输入源切换——get_user_perms 读 system_flags('perms_input') 分支
--   legacy:  现有 role_id 逻辑（168 版，role 行按 roles.code 匹配）
--   casdoor: role_codes UNION（org_users.role_codes 数组 + data_permissions role 行）
--   多角色 UNION 语义：权限从所有已分配角色合并（取并集/bool_or）
--   个人 override 语义不变（user 行覆盖基底）
-- 幂等：DROP FUNCTION IF EXISTS + CREATE FUNCTION（migrate.sh 可重跑）。
BEGIN;

-- ① shadow diff 日志表（供 perm-shadow job 写入双源比对结果）
CREATE TABLE IF NOT EXISTS perm_shadow_log (
  id            SERIAL PRIMARY KEY,
  wecom_id      TEXT NOT NULL,
  legacy_perms  JSONB,
  casdoor_perms JSONB,
  diff_keys     TEXT[],             -- 存在差异的 key 列表（空数组=无差异）
  checked_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_perm_shadow_log_checked ON perm_shadow_log(checked_at);
COMMENT ON TABLE perm_shadow_log IS 'U2 shadow diff 日志：双源权限比对结果（每日累积，切换前需连续 ≥7 天 diff=0）';

GRANT SELECT, INSERT ON perm_shadow_log TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE perm_shadow_log_id_seq TO anon, authenticated;

-- ② get_user_perms 重建：读 system_flags('perms_input') 分支
DROP FUNCTION IF EXISTS get_user_perms(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_mode TEXT;
  v_role_id INT; v_dept_ids JSONB;
  v_role_codes TEXT[];
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_out_branch JSONB := '[]'::jsonb; v_out_brands JSONB := '[]'::jsonb;
  v_out_cats JSONB := '[]'::jsonb;  v_out_cost BOOLEAN := false;
  v_has_user BOOLEAN := false;
  v_ub JSONB := NULL; v_ubr JSONB := NULL; v_uc JSONB := NULL; v_ucost BOOLEAN := NULL;
BEGIN
  -- 0a) 读输入源开关（缺省 legacy，与 170 一致）
  SELECT coalesce((SELECT f.value FROM system_flags f WHERE f.key = 'perms_input'), 'legacy')
    INTO v_mode;

  -- 0b) 用户行 + 部门
  SELECT u.department_ids INTO v_dept_ids
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  -- ============================================================
  -- 分支：legacy（role_id 路径，168 版逻辑）
  -- ============================================================
  IF v_mode = 'legacy' THEN
    -- 0c) 读 role_id
    SELECT u.role_id INTO v_role_id
    FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;

    -- 1) 角色 UI 档案（单角色）
    IF v_role_id IS NOT NULL THEN
      SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
      FROM roles r WHERE r.id = v_role_id AND r.is_active;
    END IF;

    -- 2) 个人 override（同 168 逻辑）
    SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    IF v_has_user THEN
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_ub
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
        AND jsonb_typeof(dp.branch_nums)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_ubr
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.brands IS NOT NULL
        AND jsonb_typeof(dp.brands)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_uc
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.categories IS NOT NULL
        AND jsonb_typeof(dp.categories)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT bool_or(dp.can_see_cost) INTO v_ucost
      FROM data_permissions dp
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.can_see_cost IS NOT NULL
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    END IF;

    -- 3) 基底：单角色行 ∪ 部门行（168 版，role 行按 code 匹配）
    WITH rows AS (
      SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
      WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
        AND ( (dp.subject_type='role' AND dp.subject_id = v_role_code
               AND EXISTS (SELECT 1 FROM roles r WHERE r.code = dp.subject_id AND r.is_active))
           OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
               AND jsonb_typeof(v_dept_ids) = 'array'
               AND (dp.subject_id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))))
         )
    ), b AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.branch_nums,'[]'::jsonb)) AS n(e)
      WHERE r.branch_nums IS NOT NULL AND jsonb_typeof(r.branch_nums)='array'
    ), br AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.brands,'[]'::jsonb)) AS n(e)
      WHERE r.brands IS NOT NULL AND jsonb_typeof(r.brands)='array'
    ), c AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.categories,'[]'::jsonb)) AS n(e)
      WHERE r.categories IS NOT NULL AND jsonb_typeof(r.categories)='array'
    ), cost AS (
      SELECT coalesce(bool_or(r.can_see_cost), false) v FROM rows r WHERE r.can_see_cost IS NOT NULL
    )
    SELECT b.v, br.v, c.v, cost.v INTO v_out_branch, v_out_brands, v_out_cats, v_out_cost FROM b, br, c, cost;

  -- ============================================================
  -- 分支：casdoor（role_codes 数组路径，多角色 UNION）
  -- ============================================================
  ELSE
    -- 0c) 读 role_codes（TEXT[] 数组）
    SELECT u.role_codes INTO v_role_codes
    FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
    IF v_role_codes IS NULL THEN v_role_codes := '{}'; END IF;

    -- 1) 角色 UI 档案：取 role_codes 中第一个 active 角色的 UI 字段
    --    （多角色 UI 合并策略待定；当前取 sort_order 最小的 active 角色）
    IF array_length(v_role_codes, 1) > 0 THEN
      SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
      FROM roles r
      WHERE r.code = ANY(v_role_codes) AND r.is_active
      ORDER BY r.sort_order NULLS LAST, r.code
      LIMIT 1;
    END IF;

    -- 2) 个人 override（同 legacy 逻辑，不变）
    SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    IF v_has_user THEN
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_ub
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
        AND jsonb_typeof(dp.branch_nums)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_ubr
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.brands IS NOT NULL
        AND jsonb_typeof(dp.brands)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
        INTO v_uc
      FROM data_permissions dp
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.categories IS NOT NULL
        AND jsonb_typeof(dp.categories)='array'
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
      SELECT bool_or(dp.can_see_cost) INTO v_ucost
      FROM data_permissions dp
      WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.can_see_cost IS NOT NULL
        AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    END IF;

    -- 3) 基底：多角色行 UNION ∪ 部门行（casdoor 多角色合并语义）
    --    role_codes 数组中每个 code 对应 data_permissions(subject_type='role', subject_id=code) 行
    --    所有角色行取并集（四维分别聚合：DISTINCT + bool_or）
    WITH rows AS (
      SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
      WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
        AND ( (dp.subject_type='role' AND dp.subject_id = ANY(v_role_codes)
               AND EXISTS (SELECT 1 FROM roles r WHERE r.code = dp.subject_id AND r.is_active))
           OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
               AND jsonb_typeof(v_dept_ids) = 'array'
               AND (dp.subject_id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))))
         )
    ), b AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.branch_nums,'[]'::jsonb)) AS n(e)
      WHERE r.branch_nums IS NOT NULL AND jsonb_typeof(r.branch_nums)='array'
    ), br AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.brands,'[]'::jsonb)) AS n(e)
      WHERE r.brands IS NOT NULL AND jsonb_typeof(r.brands)='array'
    ), c AS (
      SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.categories,'[]'::jsonb)) AS n(e)
      WHERE r.categories IS NOT NULL AND jsonb_typeof(r.categories)='array'
    ), cost AS (
      SELECT coalesce(bool_or(r.can_see_cost), false) v FROM rows r WHERE r.can_see_cost IS NOT NULL
    )
    SELECT b.v, br.v, c.v, cost.v INTO v_out_branch, v_out_brands, v_out_cats, v_out_cost FROM b, br, c, cost;
  END IF;

  -- 4) 合成：个人该维「配了」→ 覆盖；否则基底（两分支共用）
  IF v_ub  IS NOT NULL THEN v_out_branch := v_ub;  END IF;
  IF v_ubr IS NOT NULL THEN v_out_brands := v_ubr; END IF;
  IF v_uc  IS NOT NULL THEN v_out_cats   := v_uc;  END IF;
  IF v_ucost IS NOT NULL THEN v_out_cost  := v_ucost; END IF;

  -- 5) 兜底：含 "*" 收敛为 ["*"]；空数组 → ["*"]
  IF v_out_branch @> '"*"'::jsonb THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF v_out_brands  @> '"*"'::jsonb THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF v_out_cats    @> '"*"'::jsonb THEN v_out_cats    := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_branch)=0 THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_brands)=0  THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_cats)=0    THEN v_out_cats    := '["*"]'::jsonb; END IF;

  RETURN jsonb_build_object('role_code', v_role_code, 'branch_nums', v_out_branch, 'brands', v_out_brands,
    'categories', v_out_cats, 'can_see_cost', v_out_cost,
    'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels);
END;
$$;
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC（175 分支版）：读 system_flags(perms_input) 决定 legacy(role_id) 或 casdoor(role_codes UNION)；个人 override 不变';
GRANT EXECUTE ON get_user_perms(VARCHAR) TO anon, authenticated;

-- ③ get_user_perms_casdoor：纯 casdoor 路径独立副本（shadow diff 用，不读开关，硬编码 casdoor 逻辑）
DROP FUNCTION IF EXISTS get_user_perms_casdoor(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms_casdoor(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_dept_ids JSONB; v_role_codes TEXT[];
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_out_branch JSONB := '[]'::jsonb; v_out_brands JSONB := '[]'::jsonb;
  v_out_cats JSONB := '[]'::jsonb;  v_out_cost BOOLEAN := false;
  v_has_user BOOLEAN := false;
  v_ub JSONB := NULL; v_ubr JSONB := NULL; v_uc JSONB := NULL; v_ucost BOOLEAN := NULL;
BEGIN
  SELECT u.department_ids, coalesce(u.role_codes, '{}')
    INTO v_dept_ids, v_role_codes
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  -- 角色 UI 档案：取 role_codes 中第一个 active 角色
  IF array_length(v_role_codes, 1) > 0 THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
    INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r
    WHERE r.code = ANY(v_role_codes) AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code
    LIMIT 1;
  END IF;

  -- 个人 override
  SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
  WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
    AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  IF v_has_user THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_ub
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
      AND jsonb_typeof(dp.branch_nums)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_ubr
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.brands IS NOT NULL
      AND jsonb_typeof(dp.brands)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_uc
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.categories IS NOT NULL
      AND jsonb_typeof(dp.categories)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT bool_or(dp.can_see_cost) INTO v_ucost
    FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.can_see_cost IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  END IF;

  -- 基底：多角色 UNION ∪ 部门
  WITH rows AS (
    SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
    WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
      AND ( (dp.subject_type='role' AND dp.subject_id = ANY(v_role_codes)
             AND EXISTS (SELECT 1 FROM roles r WHERE r.code = dp.subject_id AND r.is_active))
         OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
             AND jsonb_typeof(v_dept_ids) = 'array'
             AND (dp.subject_id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))))
       )
  ), b AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.branch_nums,'[]'::jsonb)) AS n(e)
    WHERE r.branch_nums IS NOT NULL AND jsonb_typeof(r.branch_nums)='array'
  ), br AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.brands,'[]'::jsonb)) AS n(e)
    WHERE r.brands IS NOT NULL AND jsonb_typeof(r.brands)='array'
  ), c AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.categories,'[]'::jsonb)) AS n(e)
    WHERE r.categories IS NOT NULL AND jsonb_typeof(r.categories)='array'
  ), cost AS (
    SELECT coalesce(bool_or(r.can_see_cost), false) v FROM rows r WHERE r.can_see_cost IS NOT NULL
  )
  SELECT b.v, br.v, c.v, cost.v INTO v_out_branch, v_out_brands, v_out_cats, v_out_cost FROM b, br, c, cost;

  IF v_ub  IS NOT NULL THEN v_out_branch := v_ub;  END IF;
  IF v_ubr IS NOT NULL THEN v_out_brands := v_ubr; END IF;
  IF v_uc  IS NOT NULL THEN v_out_cats   := v_uc;  END IF;
  IF v_ucost IS NOT NULL THEN v_out_cost  := v_ucost; END IF;

  IF v_out_branch @> '"*"'::jsonb THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF v_out_brands  @> '"*"'::jsonb THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF v_out_cats    @> '"*"'::jsonb THEN v_out_cats    := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_branch)=0 THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_brands)=0  THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_cats)=0    THEN v_out_cats    := '["*"]'::jsonb; END IF;

  RETURN jsonb_build_object('role_code', v_role_code, 'branch_nums', v_out_branch, 'brands', v_out_brands,
    'categories', v_out_cats, 'can_see_cost', v_out_cost,
    'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels);
END;
$$;
COMMENT ON FUNCTION get_user_perms_casdoor(VARCHAR) IS 'Shadow diff 专用：纯 casdoor(role_codes) 路径独立副本，不读 system_flags，供 perm-shadow job 双源比对';
GRANT EXECUTE ON get_user_perms_casdoor(VARCHAR) TO anon, authenticated;

-- ④ get_user_perms_legacy：纯 legacy 路径独立副本（shadow diff 用，不读开关，硬编码 role_id 逻辑）
DROP FUNCTION IF EXISTS get_user_perms_legacy(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms_legacy(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role_id INT; v_dept_ids JSONB;
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_out_branch JSONB := '[]'::jsonb; v_out_brands JSONB := '[]'::jsonb;
  v_out_cats JSONB := '[]'::jsonb;  v_out_cost BOOLEAN := false;
  v_has_user BOOLEAN := false;
  v_ub JSONB := NULL; v_ubr JSONB := NULL; v_uc JSONB := NULL; v_ucost BOOLEAN := NULL;
BEGIN
  SELECT u.role_id, u.department_ids INTO v_role_id, v_dept_ids
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  IF v_role_id IS NOT NULL THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
    INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.id = v_role_id AND r.is_active;
  END IF;

  SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
  WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
    AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  IF v_has_user THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_ub
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
      AND jsonb_typeof(dp.branch_nums)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_ubr
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.brands IS NOT NULL
      AND jsonb_typeof(dp.brands)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL) INTO v_uc
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.categories IS NOT NULL
      AND jsonb_typeof(dp.categories)='array' AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
    SELECT bool_or(dp.can_see_cost) INTO v_ucost
    FROM data_permissions dp
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.can_see_cost IS NOT NULL
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  END IF;

  -- 基底：单角色 ∪ 部门（legacy: role_id::text → roles join → code 匹配）
  WITH rows AS (
    SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
    WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
      AND ( (dp.subject_type='role' AND dp.subject_id = v_role_code
             AND EXISTS (SELECT 1 FROM roles r WHERE r.code = dp.subject_id AND r.is_active))
         OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
             AND jsonb_typeof(v_dept_ids) = 'array'
             AND (dp.subject_id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))))
       )
  ), b AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.branch_nums,'[]'::jsonb)) AS n(e)
    WHERE r.branch_nums IS NOT NULL AND jsonb_typeof(r.branch_nums)='array'
  ), br AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.brands,'[]'::jsonb)) AS n(e)
    WHERE r.brands IS NOT NULL AND jsonb_typeof(r.brands)='array'
  ), c AS (
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb) v FROM rows r
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(r.categories,'[]'::jsonb)) AS n(e)
    WHERE r.categories IS NOT NULL AND jsonb_typeof(r.categories)='array'
  ), cost AS (
    SELECT coalesce(bool_or(r.can_see_cost), false) v FROM rows r WHERE r.can_see_cost IS NOT NULL
  )
  SELECT b.v, br.v, c.v, cost.v INTO v_out_branch, v_out_brands, v_out_cats, v_out_cost FROM b, br, c, cost;

  IF v_ub  IS NOT NULL THEN v_out_branch := v_ub;  END IF;
  IF v_ubr IS NOT NULL THEN v_out_brands := v_ubr; END IF;
  IF v_uc  IS NOT NULL THEN v_out_cats   := v_uc;  END IF;
  IF v_ucost IS NOT NULL THEN v_out_cost  := v_ucost; END IF;

  IF v_out_branch @> '"*"'::jsonb THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF v_out_brands  @> '"*"'::jsonb THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF v_out_cats    @> '"*"'::jsonb THEN v_out_cats    := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_branch)=0 THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_brands)=0  THEN v_out_brands  := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_cats)=0    THEN v_out_cats    := '["*"]'::jsonb; END IF;

  RETURN jsonb_build_object('role_code', v_role_code, 'branch_nums', v_out_branch, 'brands', v_out_brands,
    'categories', v_out_cats, 'can_see_cost', v_out_cost,
    'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels);
END;
$$;
COMMENT ON FUNCTION get_user_perms_legacy(VARCHAR) IS 'Shadow diff 专用：纯 legacy(role_id) 路径独立副本，不读 system_flags，供 perm-shadow job 双源比对';
GRANT EXECUTE ON get_user_perms_legacy(VARCHAR) TO anon, authenticated;

COMMIT;

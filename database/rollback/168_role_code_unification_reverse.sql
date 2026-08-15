-- 168_role_code_unification_reverse.sql（反向迁移 / 真回滚演练）
-- ⚠️ 本文件在 database/rollback/ 目录，【绝不放进 database/migrations/】——
--    migrate.sh 每次部署全量重跑 migrations/，反向脚本入列会把键每次改回 role_id::text。
-- 用法（仅人工显式回滚时）：
--   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d insforge -f - < database/rollback/168_role_code_unification_reverse.sql
-- 做两件事（缺一不可）：
--   ① role 行 subject_id 还原为 role_id::text（幂等，重跑 no-op）；
--   ② get_user_perms 还原为 167 原版（role 行按 role_id::text 匹配）——
--      只还原键不还原函数 = 角色基底失配 → 空基底兜底 ["*"] = 全员权限静默放大，禁止。
-- 快照表 perm_migration_snapshot 不动（回滚后仍是迁移前基准；重跑正向迁移 IF NOT EXISTS 跳过、沿用原快照）。
BEGIN;

UPDATE data_permissions dp SET subject_id = r.id::text
  FROM roles r WHERE dp.subject_type='role' AND dp.subject_id = r.code;

DROP FUNCTION IF EXISTS get_user_perms(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_role_id INT; v_dept_ids JSONB;
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_out_branch JSONB := '[]'::jsonb; v_out_brands JSONB := '[]'::jsonb;
  v_out_cats JSONB := '[]'::jsonb;  v_out_cost BOOLEAN := false;
  v_user_branch JSONB; v_user_brands JSONB; v_user_cats JSONB; v_user_cost BOOLEAN;
  v_has_user BOOLEAN := false;
  v_ub JSONB := NULL; v_ubr JSONB := NULL; v_uc JSONB := NULL; v_ucost BOOLEAN := NULL;
BEGIN
  -- 0) 用户 + 角色 + 部门
  SELECT u.role_id, u.department_ids INTO v_role_id, v_dept_ids
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb, 'can_see_cost', false,
      'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
  END IF;

  -- 1) 角色 UI 档案
  IF v_role_id IS NOT NULL THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
    INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.id = v_role_id AND r.is_active;
  END IF;

  -- 2) 个人 override：逐维「是否配了」（非 NULL）+ 配置值
  SELECT count(*)>0 INTO v_has_user FROM data_permissions dp
  WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id
    AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  IF v_has_user THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e) FILTER (WHERE n.e IS NOT NULL), NULL)
      INTO v_ub
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type='user' AND dp.subject_id=p_wecom_id AND dp.branch_nums IS NOT NULL
      AND jsonb_typeof(dp.branch_nums)='array'   -- F5：非数组 JSON → 跳过该维（防 lateral 报错 → 登录兜底全放行）
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

  -- 3) 基底：角色行 ∪ 部门行（四维，忽略 NULL 维，过滤过期）——【167 原版：role 行按 role_id::text 匹配】
  WITH rows AS (
    SELECT branch_nums, brands, categories, can_see_cost FROM data_permissions dp
    WHERE (dp.expires_at IS NULL OR dp.expires_at > NOW())
      AND ( (dp.subject_type='role' AND dp.subject_id = v_role_id::text
             -- F3（安全终检 review）：停用角色（is_active=false）仅 UI 档案停用、数据范围仍在基底 → 语义不符。
             --     role 行贡献须叠加 roles.is_active，停用即从基底剥离。
             AND EXISTS (SELECT 1 FROM roles r WHERE r.id::text = dp.subject_id AND r.is_active))
         OR (dp.subject_type='dept' AND v_dept_ids IS NOT NULL
             -- jsonb_typeof 防御（072 旧函数体恢复）：department_ids 非数组时跳过部门层，
             -- 避免 jsonb_array_elements_text 报错 → 调用方兜底全放行（静默放大权限）
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

  -- 4) 合成：个人该维「配了」→ 覆盖；否则基底
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
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC：角色∪部门基底叠加，个人 override 按字段覆盖（NULL=不覆盖）；返回四维+角色 UI 字段。【反向态：role 行 subject_id=role_id::text】';

GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;

COMMIT;

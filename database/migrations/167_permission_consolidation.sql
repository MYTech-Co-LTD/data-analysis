-- 167_permission_consolidation.sql
-- 权限体系重构（issue #2 / spec 2026-08-13-permission-refactor-design.md）：
-- data_permissions 单表授权 + get_user_perms 逐维合成 + permission_audit。
-- 幂等：migrate.sh 可重复执行；ON_ERROR_STOP=1 整体回滚。
--   §②/§③ 用 DO 块 + 存在性判断包裹（列/表在首次执行后被 DROP，重跑迁移须跳过），
--   语义与 plan 一致：仅迁入尚不存在的 dept/user 行。
BEGIN;

-- ① data_permissions 语义：NULL = 该维未配置（不参与合成）
ALTER TABLE data_permissions ALTER COLUMN branch_nums SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN brands    SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN categories SET DEFAULT NULL;
ALTER TABLE data_permissions ALTER COLUMN can_see_cost SET DEFAULT NULL;
COMMENT ON COLUMN data_permissions.branch_nums IS '门店范围；NULL=该维未配置；["*"]=全放行';
COMMENT ON COLUMN data_permissions.brands IS '品牌范围；NULL=该维未配置（dept 行恒 NULL）';
COMMENT ON COLUMN data_permissions.categories IS '品类范围；NULL=该维未配置（dept 行恒 NULL）';
COMMENT ON COLUMN data_permissions.can_see_cost IS '成本可见；NULL=该维未配置';

-- ② 部门权限收编：org_departments(权限列) → data_permissions(subject_type='dept')
--    幂等：列在首次执行后被 §④ DROP，重跑前由 015 ADD COLUMN IF NOT EXISTS 重建；
--    此处仍以存在性判断包裹，保证迁移文件自身可独立重跑。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='org_departments' AND column_name='branch_nums') THEN
    INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
    SELECT 'dept', d.id::text, d.branch_nums, NULL, NULL, d.can_see_cost, '迁移自org_departments'
    FROM org_departments d
    WHERE d.is_active
      AND NOT EXISTS (SELECT 1 FROM data_permissions dp
                      WHERE dp.subject_type='dept' AND dp.subject_id=d.id::text);
  END IF;
END $$;

-- ③ 老按人表收编 + 退役
--    幂等：表在首次执行后被 DROP；migrate.sh 重跑时由 016 CREATE TABLE IF NOT EXISTS 重建（空表），
--    此处以存在性判断包裹，保证迁移文件自身可独立重跑。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='retail_query_user_perms') THEN
    INSERT INTO data_permissions (subject_type, subject_id, branch_nums, can_see_cost, note)
    SELECT 'user', wecom_id, branch_nums, can_see_cost, '迁移自retail_query_user_perms'
    FROM retail_query_user_perms r
    WHERE NOT EXISTS (SELECT 1 FROM data_permissions dp
                      WHERE dp.subject_type='user' AND dp.subject_id=r.wecom_id);
    DROP TABLE retail_query_user_perms;
  END IF;
END $$;

-- ④ org_departments 权限列退休（唯一引用 get_user_perms + preview 路由，均本轮改写）
ALTER TABLE org_departments DROP COLUMN IF EXISTS branch_nums;
ALTER TABLE org_departments DROP COLUMN IF EXISTS can_see_cost;

-- ⑤ 变更审计表
CREATE TABLE IF NOT EXISTS permission_audit (
  id             SERIAL PRIMARY KEY,
  actor_wecom_id TEXT NOT NULL,
  actor_name     TEXT,
  action         TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT,
  payload_before JSONB,
  payload_after  JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE permission_audit IS '权限变更审计（仅经管理 API 写；SQL 直改绕不过，运维文档注明一律走页面）';

-- ⑤b 管理路由（web 容器经 PostgREST 以 anon 角色执行，INSFORGE_API_KEY=ANON_KEY JWT role=anon）所需表授权。
--    F1 修复（安全终检 review）：002 GRANT 被 003 REVOKE、072 DROP+重建 data_permissions 带回授权丢失，
--    167 此前仅 GRANT get_user_perms EXECUTE——读路径 403 静默空、permission_audit 全套零权限（审计死）。
--    幂等：GRANT 语句天然幂等，重跑无副作用。
GRANT SELECT, INSERT, UPDATE, DELETE ON data_permissions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON permission_audit TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE permission_audit_id_seq TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE data_permissions_id_seq TO anon, authenticated;

-- ⑥ get_user_perms 逐维合成重写（签名/返回结构/兜底语义均不变）
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

  -- 3) 基底：角色行 ∪ 部门行（四维，忽略 NULL 维，过滤过期）
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
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC：角色∪部门基底叠加，个人 override 按字段覆盖（NULL=不覆盖）；返回四维+角色 UI 字段';

GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;

COMMIT;

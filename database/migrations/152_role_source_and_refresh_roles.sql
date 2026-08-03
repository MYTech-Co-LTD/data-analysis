-- 152_role_source_and_refresh_roles.sql
-- 权限收口：org_users.role_source（auto/manual）+ refresh_role_assignments() RPC
-- 设计：docs/superpowers/specs/2026-08-03-report-permission-lockdown-design.md C2
-- 幂等：可由 scripts/migrate.sh 重复执行。

BEGIN;

-- ① role_source：manual（管理页指派）不被同步覆盖；auto 每次同步按 dept_role_mapping 重算
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_source TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE org_users DROP CONSTRAINT IF EXISTS org_users_role_source_check;
ALTER TABLE org_users ADD CONSTRAINT org_users_role_source_check CHECK (role_source IN ('auto','manual'));
COMMENT ON COLUMN org_users.role_source IS 'role_id 来源：auto=同步按 dept_role_mapping 自动赋值（可被覆盖）；manual=管理页手工指派（同步不动）';

-- ② refresh_role_assignments()：新部门补映射 + auto 用户重算 role_id
--   映射正则与 072 ⑦ 一致；无匹配部门默认 manager（最小权限兜底）。
--   多部门命中取 priority 最高。无部门/无映射用户 role_id 置 NULL（待 admin 配）。
CREATE OR REPLACE FUNCTION refresh_role_assignments() RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mapped INT := 0;
  v_assigned INT := 0;
BEGIN
  -- 1) 新部门补映射（同 072 ⑦ 正则；已有映射的部门跳过）
  INSERT INTO dept_role_mapping (dept_id, role_id, priority)
  SELECT d.id, r.id,
    CASE WHEN d.name ~ '(总经办|运营总|老板)' THEN 10 ELSE 1 END
  FROM org_departments d
  CROSS JOIN LATERAL (
    SELECT id FROM roles WHERE code =
      CASE
        WHEN d.name ~ '(总经办|运营总|老板)' THEN 'boss'
        WHEN d.name ~ '(战区|区域|大区)'     THEN 'zone_manager'
        WHEN d.name ~ '(店长|门店)'          THEN 'manager'
        WHEN d.name ~ '(采购|业务|品类)'     THEN 'buyer'
        WHEN d.name ~ '(财务)'               THEN 'finance'
        ELSE 'manager'
      END
  ) r
  WHERE d.is_active
    AND NOT EXISTS (SELECT 1 FROM dept_role_mapping m WHERE m.dept_id = d.id);
  GET DIAGNOSTICS v_mapped = ROW_COUNT;

  -- 2) auto 用户按部门映射重算 role_id（manual 不动；无映射 -> NULL 待 admin 配）
  UPDATE org_users u
  SET role_id = m.role_id
  FROM (
    SELECT u2.wecom_id,
      (SELECT drm.role_id FROM dept_role_mapping drm
       WHERE drm.dept_id IN (SELECT jsonb_array_elements_text(u2.department_ids))
       ORDER BY drm.priority DESC, drm.role_id
       LIMIT 1) AS role_id
    FROM org_users u2
    WHERE u2.is_active AND u2.role_source = 'auto'
  ) m
  WHERE u.wecom_id = m.wecom_id
    AND u.role_id IS DISTINCT FROM m.role_id;
  GET DIAGNOSTICS v_assigned = ROW_COUNT;

  RETURN jsonb_build_object('mapped', v_mapped, 'assigned', v_assigned);
END;
$$;
COMMENT ON FUNCTION refresh_role_assignments() IS '权限收口：通讯录同步后调用--新部门补 dept_role_mapping + auto 用户重算 role_id（manual 不覆盖）';

GRANT EXECUTE ON FUNCTION refresh_role_assignments() TO anon, authenticated;

COMMIT;

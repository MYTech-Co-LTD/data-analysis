-- database/migrations/189_get_user_perms_offboard_deny.sql
-- 离职四 sink（188/189 配对，2026-08-17 T6 真机验证发现）：
-- 185 的 get_user_perms NOT FOUND 分支（is_active=false 或不存在）返回宽松哨兵
-- ["*"]（历史为 system:cron 服务身份保留），但**离职用户撞同一分支**：
--   ① 登录窗口洞：sync-contacts 置 is_active=false → thin-sync ≤30min 后才 Casdoor disable，
--      窗口内用户仍可登录 → callback 拿 ["*"] → 签发 7 天全店 JWT（web 面由 188 sink① 60s 拒，
--      agent 面不走 web middleware）
--   ② agent 面洞：agent-query 直调 get_user_perms（line 340），离职 userId → ["*"] 全店
-- 修复：NOT FOUND 分支分流——服务身份（system:% 前缀，agent-query 无 userId 时默认
-- 'system:cron'）保留宽松 ["*"]；真实用户（离职/不存在）→ deny 形状（branch_nums=[]
-- 全维空 + can_see_cost=false，与无组用户 deny 同形状，B1）。
-- strict 版（185 ③b）本就离职→NULL fail-close，不受影响。
-- 幂等：CREATE OR REPLACE。

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
    IF p_wecom_id LIKE 'system:%' THEN
      -- 服务身份（system:cron 等，agent-query 定时链路）：宽松形状保留（185 语义，非用户面）
      RETURN jsonb_build_object('role_code', null, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb,
        'categories', '["*"]'::jsonb, 'can_see_cost', false,
        'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb);
    END IF;
    -- 真实用户离职/不存在（189）：deny 形状 fail-close——离职工 sink 数据面收口，
    -- 登录窗口内撞入也只签 deny JWT（branch_nums=[]）；agent-query 同形状 0 行。
    RETURN jsonb_build_object('role_code', null, 'branch_nums', '[]'::jsonb, 'brands', '[]'::jsonb,
      'categories', '[]'::jsonb, 'can_see_cost', false,
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

COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合成 RPC（185 casdoor-only 终版；189 离职收口）：角色 UI=roles×role_codes；branch_nums=groups(F9)×maps_branch_group 展开；can_see_cost=temporary_grants 例外；brands/categories=[]（权威源=登录 claims data_scope）。NOT FOUND 分支（189）：system:% 服务身份保留宽松 ["*"]；真实用户离职/不存在 → deny 形状（branch_nums=[] 全维空，离职工 sink 数据面收口）';

-- 验证断言（重复执行不报错）：函数存在且 NOT FOUND 分支已分流
DO $$
DECLARE
  v_offboard JSONB; v_svc JSONB;
  v_off_branch TEXT; v_svc_branch TEXT;
BEGIN
  SELECT get_user_perms('__189_verify_offboard__') INTO v_offboard;
  SELECT get_user_perms('system:cron') INTO v_svc;
  v_off_branch := v_offboard ->> 'branch_nums';
  v_svc_branch := v_svc ->> 'branch_nums';
  IF v_off_branch <> '[]' THEN
    RAISE EXCEPTION '189 verification failed: offboard user should deny ([]), got %', v_off_branch;
  END IF;
  IF v_svc_branch <> '["*"]' THEN
    RAISE EXCEPTION '189 verification failed: system:% should stay permissive (["*"]), got %', v_svc_branch;
  END IF;
END $$;

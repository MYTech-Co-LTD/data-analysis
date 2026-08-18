-- 200_get_user_perms_scope_resources.sql
-- M3：get_user_perms 切换为「scope_resources 投影 → SQL 解析」（方案 A，数据范围持久投影）。
--   无会话链路（run_push / agent-query / preview）经 get_user_perms 从 org_users.scope_resources
--   （199 投影列）解析出与登录 claims 同源的 data_scope+fields，代签 JWT 升级为新形状使 RLS 放行。
-- 依赖：199（org_users.scope_resources 列）、187（maps_branch_group (group_id,branch_number) 复合唯一，
--   部门组多对多映射）、maps_branch_group/dim_branch（branch_number 全局唯一派生键）。
--
-- M1/spec-forge：双形过渡——RETURN 同时含旧顶层四维（branch_nums/brands/categories/can_see_cost，
--   消费端迁移期读）+ 新 data_scope{...}/fields{cost}（同源同值）；M6 摘旧 key。
-- M2/spec-forge：裸 '*' 非投影键，无 @> ARRAY['*'] 全权分支；唯一通配 = data-analysis:branch:全店 / :*。
-- M7/spec-forge：coalesce 防 NULL 毒化（空分区包 v_tmp=NULL → 整列污染；PostgreSQL `||` 视 NULL 为
--   空数组，但 NULL||NULL 仍为 NULL，空包首键时毒化——coalesce 将其转成空数组）。
-- M11/spec-forge：get_user_perms_strict 判定源 scope_resources（无 role_codes ∧ 无 scope_resources → NULL），
--   移除 temp-grant 子句（197 已冻结，不构成授权面，防「过闸但函数不读」自相矛盾）。
-- system:% 服务身份宽松形状保留；NOT FOUND 真实用户 deny 形状（189 语义）。
--
-- 幂等：CREATE OR REPLACE + GRANT（migrate.sh 每次部署重跑全部迁移，安全）。
-- 语义对齐 claims.js resolveScopeKeys + collapseFullStore：
--   键形态 = 包名（maps.group_id，多行）| branch_number | 门店中文名（dim_branch.branch_name 唯一命中）；
--   fail-close：未知/重名 → 整单 []；全店集合**相等**才收敛 ['*']（M2 Global Constraint）。
BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_perms(p_wecom_id character varying)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_dept_ids JSONB;
  v_role_codes TEXT[];
  v_scope_resources TEXT[];
  v_role_code TEXT; v_role_landing TEXT; v_role_metric TEXT; v_role_panels JSONB := '[]'::jsonb;
  v_branch JSONB := '[]'::jsonb;
  v_brands JSONB := '[]'::jsonb;
  v_categories JSONB := '[]'::jsonb;
  v_cost BOOLEAN := false;
  v_branch_keys TEXT[];
  v_key TEXT; v_tmp TEXT[]; v_collapsed TEXT[]; v_name_count INT; v_name_branch TEXT;
  v_unknown BOOLEAN := false; v_ambiguous BOOLEAN := false;
  v_universe_size INT; v_result_size INT;
BEGIN
  SELECT u.department_ids, coalesce(u.role_codes, '{}'), coalesce(u.scope_resources, '{}')
    INTO v_dept_ids, v_role_codes, v_scope_resources
  FROM org_users u WHERE u.wecom_id = p_wecom_id AND u.is_active;
  IF NOT FOUND THEN
    IF p_wecom_id LIKE 'system:%' THEN
      -- 服务身份（system:cron 等，agent-query 定时链路）：宽松形状保留（189 语义），补 data_scope/fields 同源
      RETURN jsonb_build_object('role_code', null, 'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb,
        'departments', '[]'::jsonb, 'branch_nums', '["*"]'::jsonb, 'brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'can_see_cost', false,
        'data_scope', jsonb_build_object('brands', '["*"]'::jsonb, 'categories', '["*"]'::jsonb, 'branch_nums', '["*"]'::jsonb),
        'fields', jsonb_build_object('cost', false));
    END IF;
    -- 真实用户离职/不存在（189）：deny 形状 fail-close（branch_nums=[] 全维空），补 data_scope/fields 同源
    RETURN jsonb_build_object('role_code', null, 'default_landing', null, 'default_metric', null, 'visible_panels', '[]'::jsonb,
      'departments', '[]'::jsonb, 'branch_nums', '[]'::jsonb, 'brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'can_see_cost', false,
      'data_scope', jsonb_build_object('brands', '[]'::jsonb, 'categories', '[]'::jsonb, 'branch_nums', '[]'::jsonb),
      'fields', jsonb_build_object('cost', false));
  END IF;

  -- 角色 UI 档案（保留 175/185 语义）：role_codes 中 sort_order 最小的 active 角色
  IF array_length(v_role_codes, 1) > 0 THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r WHERE r.code = ANY(v_role_codes) AND r.is_active
    ORDER BY r.sort_order NULLS LAST, r.code LIMIT 1;
  END IF;

  -- M2：无通配全权分支（裸 '*' 非投影键）；brands/categories/cost 从前缀剥离（brand:* 是合法投影键→brands ['*']）
  SELECT COALESCE(jsonb_agg(substring(r FROM 'data-analysis:brand:(.*)$')), '[]'::jsonb) INTO v_brands
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:brand:%';
  SELECT COALESCE(jsonb_agg(substring(r FROM 'data-analysis:category:(.*)$')), '[]'::jsonb) INTO v_categories
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:category:%';
  v_cost := EXISTS (SELECT 1 FROM unnest(v_scope_resources) r WHERE r = 'data-analysis:field:cost');

  -- branch keys 解析（fail-close：任一未知/歧义 → 整单 []）
  SELECT array_agg(substring(r FROM 'data-analysis:branch:(.*)$')) INTO v_branch_keys
    FROM unnest(v_scope_resources) r WHERE r LIKE 'data-analysis:branch:%';
  IF v_branch_keys IS NOT NULL AND array_length(v_branch_keys, 1) > 0 THEN
    IF EXISTS (SELECT 1 FROM unnest(v_branch_keys) k WHERE k IN ('*', '全店')) THEN
      v_branch := '["*"]'::jsonb;   -- 通配短路（唯一合法通配）
    ELSE
      FOR v_key IN SELECT unnest(v_branch_keys) LOOP
        IF EXISTS (SELECT 1 FROM maps_branch_group WHERE is_active AND group_id = v_key) THEN
          -- 包名 → 包内门店并集（部门组多对多）
          SELECT array_agg(DISTINCT branch_number) INTO v_tmp FROM maps_branch_group
            WHERE is_active AND group_id = v_key AND branch_number IS NOT NULL;
          -- M7：coalesce 防 NULL 毒化（空分区包 v_tmp=NULL → 整列污染）
          v_collapsed := v_collapsed || coalesce(v_tmp, ARRAY[]::text[]);
        ELSIF EXISTS (SELECT 1 FROM maps_branch_group WHERE is_active AND branch_number = v_key) THEN
          v_collapsed := v_collapsed || ARRAY[v_key];   -- branch_number 直映
        ELSE
          -- 门店中文名：唯一命中（count=1）| 重名（>1 → ambiguous fail-close）| 未命中（unknown fail-close）
          SELECT count(*), min(branch_number) INTO v_name_count, v_name_branch FROM dim_branch WHERE branch_name = v_key;
          IF v_name_count = 1 THEN v_collapsed := v_collapsed || ARRAY[v_name_branch];
          ELSIF v_name_count > 1 THEN v_ambiguous := true;
          ELSE v_unknown := true;
          END IF;
        END IF;
      END LOOP;
      IF v_unknown OR v_ambiguous THEN
        v_branch := '[]'::jsonb;   -- fail-close 整单清空（B1）
      ELSE
        SELECT count(DISTINCT branch_number) INTO v_universe_size FROM maps_branch_group WHERE is_active AND branch_number IS NOT NULL;
        SELECT count(DISTINCT b) INTO v_result_size FROM unnest(v_collapsed) b;
        -- collapseFullStore：结果与 maps 门店全集**集合相等**才收敛 ['*']（对齐 claims.js collapseFullStore——
        --   仅比 cardinality 会漏检「同名不同集」：中文名解析出门店不在 maps universe 时 cardinality 相等但
        --   集合不同 → 假收敛 = over-grant；须显式 v_collapsed ⊆ universe）
        IF v_universe_size > 0 AND v_result_size = v_universe_size
           AND NOT EXISTS (
             SELECT 1 FROM unnest(v_collapsed) b
             WHERE NOT EXISTS (SELECT 1 FROM maps_branch_group m WHERE m.is_active AND m.branch_number = b)) THEN
          v_branch := '["*"]'::jsonb;
        ELSE
          SELECT COALESCE(jsonb_agg(b ORDER BY b), '[]'::jsonb) INTO v_branch
            FROM (SELECT DISTINCT b FROM unnest(v_collapsed) b) s;
        END IF;
      END IF;
    END IF;
  END IF;

  -- M1：双形输出——旧顶层四维 + 新 data_scope/fields（同源同值）
  RETURN jsonb_build_object('role_code', v_role_code, 'default_landing', v_role_landing, 'default_metric', v_role_metric, 'visible_panels', v_role_panels,
    'departments', v_dept_ids,
    'branch_nums', v_branch, 'brands', v_brands, 'categories', v_categories, 'can_see_cost', v_cost,
    'data_scope', jsonb_build_object('brands', v_brands, 'categories', v_categories, 'branch_nums', v_branch),
    'fields', jsonb_build_object('cost', v_cost));
END;
$function$;

COMMENT ON FUNCTION public.get_user_perms(character varying) IS '权限合成 RPC（200 scope_resources 版，M3）：输入=org_users.scope_resources 投影（199）；输出双形（旧顶层 branch_nums/brands/categories/can_see_cost + 新 data_scope/fields 同源同值）；branch 解析对齐 claims.js resolveScopeKeys+collapseFullStore（fail-close：未知/重名 → []；集合相等才收敛 [''*'']）。NOT FOUND：system:% 服务身份宽松 [''*'']；真实用户 deny []';
GRANT EXECUTE ON FUNCTION public.get_user_perms(character varying) TO anon, authenticated;

-- M11/spec-forge：get_user_perms_strict 更新——NULL 闸判定源 role_codes ∧ scope_resources，移除 temp-grant 子句
CREATE OR REPLACE FUNCTION public.get_user_perms_strict(p_wecom_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_active BOOLEAN; v_empty BOOLEAN; v_perms JSONB;
BEGIN
  -- ① 未知（无行）/离职（is_active=false）→ NULL fail-close
  SELECT u.is_active INTO v_active FROM org_users u WHERE u.wecom_id = p_wecom_id;
  IF v_active IS NULL OR NOT v_active THEN RETURN NULL; END IF;
  -- ② NULL 闸 = 无 role_codes ∧ 无 scope_resources（M11：temp-grant 197 已冻结，不构成授权面，移除子句）
  SELECT coalesce(array_length(o.role_codes, 1), 0) = 0
         AND coalesce(array_length(o.scope_resources, 1), 0) = 0
    INTO v_empty FROM org_users o WHERE o.wecom_id = p_wecom_id;
  IF coalesce(v_empty, true) THEN RETURN NULL; END IF;
  -- ③ 委托双形内核
  SELECT get_user_perms(p_wecom_id) INTO v_perms;
  RETURN v_perms;
END;
$function$;

COMMENT ON FUNCTION public.get_user_perms_strict(text) IS '引擎路径 strict 权限 RPC（200，M11）：NULL=未知/离职/空基底（无 role_codes ∧ 无 scope_resources → fail-close）；temp-grant 例外已废除（197）不构成授权面；否则委托 get_user_perms 双形内核';
GRANT EXECUTE ON FUNCTION public.get_user_perms_strict(text) TO anon, authenticated;

COMMIT;

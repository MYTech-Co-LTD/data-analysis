-- 072_permission_roles.sql
-- 权限架构 P1：角色表 + 多维数据权限表 + 部门→角色映射规则 + 5 角色种子
-- 设计文档：docs/superpowers/specs/2026-07-20-permission-role-architecture-design.md §4.1-4.5
-- 幂等：可由 scripts/migrate.sh 重复执行；ON_ERROR_STOP=1 下任一步出错即整体回滚。

BEGIN;

-- ============================================================
-- ① roles 表（角色定义 + UI 默认值）
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,           -- boss/zone_manager/manager/buyer/finance
  name            TEXT NOT NULL,                  -- 中文显示名
  default_landing TEXT,                           -- 默认落地路由，如 '/' 或 '/my-store'
  default_metric  TEXT,                           -- 默认聚焦指标 metric_code
  visible_panels  JSONB DEFAULT '[]'::jsonb,      -- 可见面板/导航项 ["targets","category_analysis","cost"]
  sort_order      INT DEFAULT 0,
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roles_active ON roles(is_active) WHERE is_active;
COMMENT ON TABLE roles IS '角色定义（5 个：boss/zone_manager/manager/buyer/finance）；UI 默认值在此，数据范围在 data_permissions(subject_type=role)';

-- ============================================================
-- ② data_permissions 表（重构：旧 schema 已废弃，按设计文档 §4.2 重建为多维数据范围 + 临时授权）
--   背景：001_init.sql 建过 data_permissions(resource_type/resource_id/permission_level) 通用 ABAC，
--   一直未启用（0 行）。设计文档 §4.2 重新定义为 subject_type/subject_id/branch_nums/brands/categories/can_see_cost/expires_at。
--   幂等策略：
--     - 旧 schema（有 resource_type 列、无 subject_type 列）→ DROP + CREATE 新 schema（无数据损失）
--     - 新 schema 已存在 → no-op
--     - 表不存在 → CREATE
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='data_permissions')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema='public' AND table_name='data_permissions' AND column_name='subject_type') THEN
    -- 旧 schema（001_init.sql 的 resource_type/resource_id/permission_level）；
    -- 设计文档 §4.2 明确重构，旧表为空（未启用），直接 DROP 重建。
    EXECUTE 'DROP TABLE data_permissions';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS data_permissions (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,                    -- 'role' | 'user' | 'dept'
  subject_id    TEXT NOT NULL,                    -- role_id::text | wecom_id | dept_id
  branch_nums   JSONB DEFAULT '["*"]'::jsonb,     -- 门店范围（"*" 通配）
  brands        JSONB DEFAULT '["*"]'::jsonb,     -- 品牌 system_book_code 范围
  categories    JSONB DEFAULT '["*"]'::jsonb,     -- 品类 category_group 范围
  can_see_cost  BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ,                      -- 临时授权时效（NULL=永久）
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_permissions_subject ON data_permissions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_data_permissions_expires ON data_permissions(expires_at) WHERE expires_at IS NOT NULL;
-- 故意不加 UNIQUE(subject_type, subject_id)：允许「永久基础 + 多个临时扩展」并存，由 get_user_perms 聚合未过期条目
COMMENT ON TABLE data_permissions IS '多维数据范围（branch_nums/brands/categories）+ 临时授权(expires_at)；subject_type=role/user/dept；RLS 关闭，仅经 SECURITY DEFINER 的 get_user_perms RPC 可读';

-- ============================================================
-- ③ dept_role_mapping 表（部门→角色自动映射规则）
-- ============================================================
CREATE TABLE IF NOT EXISTS dept_role_mapping (
  dept_id   TEXT NOT NULL,                        -- org_departments.id（企微部门 id）
  role_id   INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  priority  INT DEFAULT 0,                        -- 多部门命中时取 priority 最高
  PRIMARY KEY (dept_id, role_id)
);
COMMENT ON TABLE dept_role_mapping IS '部门→角色自动映射；通讯录同步时按 user.department_ids 查此表自动赋 role_id（多部门取 priority 最高；无匹配→留空待 admin 配）';

-- ============================================================
-- ④ org_users 加 role_id / brands 列
-- ============================================================
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS role_id INT REFERENCES roles(id);
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS brands JSONB DEFAULT '["*"]'::jsonb;
COMMENT ON COLUMN org_users.role_id IS '用户主角色（dept_role_mapping 自动赋值或 admin 手配）；NULL=未配置';
COMMENT ON COLUMN org_users.brands IS '用户级品牌 override（一般不用，默认 ["*"] 全品牌）';

-- ============================================================
-- ⑤ 5 角色种子（设计文档 §4.1）
-- ============================================================
INSERT INTO roles (code, name, default_landing, default_metric, visible_panels, sort_order) VALUES
  ('boss',         '老板/运营总',  '/',                 'sale',            '["targets","cost"]'::jsonb,              1),
  ('zone_manager', '战区主管',      '/',                 'sale',            '["targets","cost"]'::jsonb,              2),
  ('manager',      '店长',          '/my-store',         'sale',            '["targets"]'::jsonb,                     3),
  ('buyer',        '采购/业务',     '/reports/category', 'outbound_amt',    '["targets","category_analysis"]'::jsonb, 4),
  ('finance',      '财务',          '/',                 'outbound_profit', '["targets","cost"]'::jsonb,              5)
ON CONFLICT (code) DO UPDATE SET
  name=EXCLUDED.name,
  default_landing=EXCLUDED.default_landing,
  default_metric=EXCLUDED.default_metric,
  visible_panels=EXCLUDED.visible_panels,
  sort_order=EXCLUDED.sort_order;

-- ============================================================
-- ⑥ 角色级 data_permissions 种子（subject_type='role', subject_id=role_id::text）
--   幂等策略：先 DELETE 角色级条目，再 INSERT——允许参数随设计迭代更新
--   W5 守卫（Task 18 / 迁移 184，plan 外实况适配——072 也会写 data_permissions）：
--   184 写关闭（trg_dp_write_close 触发器）存在或 W6 删表后，本段跳过——
--   角色默认范围随授权语义上收 Casdoor，不再由种子重放刷新。
--   默认范围：
--     boss/zone_manager/finance: 全店/全品牌/全品类 + 可见成本
--     manager(店长):              全店/全品牌/全品类 + 不可见成本（店级范围由 get_user_perms 部门补充层覆盖）
--     buyer(采购):                全店/全品牌 + 限品类（默认水果；多品类采购由 admin 加行覆盖）
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_dp_write_close') THEN
    DELETE FROM data_permissions WHERE subject_type='role';

    INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
    SELECT
      'role',
      r.id::text,
      '["*"]'::jsonb,
      '["*"]'::jsonb,
      CASE r.code WHEN 'buyer' THEN '["水果"]'::jsonb ELSE '["*"]'::jsonb END,
      CASE WHEN r.code IN ('boss','zone_manager','finance') THEN true ELSE false END,
      '角色级默认范围（' || r.code || '）'
    FROM roles r
    WHERE r.code IN ('boss','zone_manager','manager','buyer','finance');
  END IF;
END $$;

-- ============================================================
-- ⑦ dept_role_mapping 规则种子：按 org_departments.name 推断
--   说明：本地 dev 通常 org_departments 为空（未跑通讯录同步），本节产出 0 行属正常；
--   生产环境有部门时按规则映射。无匹配 → 默认 manager（最小权限兜底，店长视角）。
--   匹配关键词（按设计文档 §4.5 + 业务语义；admin 后续可在 UI 精调）：
--     boss(优先级10): 总经办、运营总、老板
--     zone_manager:    战区、区域、大区
--     manager(默认1):  店长、门店、本店（及所有未匹配部门）
--     buyer:           采购、业务、品类
--     finance:         财务
-- ============================================================
INSERT INTO dept_role_mapping (dept_id, role_id, priority)
SELECT d.id, r.id,
  CASE WHEN d.name ~ '(总经办|运营总|老板)' THEN 10 ELSE 1 END
FROM org_departments d
CROSS JOIN LATERAL (
  SELECT id FROM roles WHERE code =
    CASE
      WHEN d.name ~ '(总经办|运营总|老板)'   THEN 'boss'
      WHEN d.name ~ '(战区|区域|大区)'       THEN 'zone_manager'
      WHEN d.name ~ '(店长|门店)'            THEN 'manager'
      WHEN d.name ~ '(采购|业务|品类)'       THEN 'buyer'
      WHEN d.name ~ '(财务)'                 THEN 'finance'
      ELSE 'manager'  -- 默认店长（最小权限兜底）
    END
) r
WHERE NOT EXISTS (SELECT 1 FROM dept_role_mapping m WHERE m.dept_id=d.id AND m.role_id=r.id);

-- ============================================================
-- ⑧ retail_query_user_perms 退役：REVOKE 写权限（保留只读）
--   数据将在后续任务迁入 data_permissions(subject_type='user')；
--   不立即 DROP（同 lemeng_items 教训：保留历史只读，避免误丢）。
-- ============================================================
REVOKE INSERT, UPDATE, DELETE ON retail_query_user_perms FROM anon, authenticated;

-- ============================================================
-- ⑨ claim_match_or_star(claim, value)：Task 3 RLS 复用的「["*"] 放行 / 否则 IN」辅助函数
--   语义（设计文档 §7.1）：claim 缺失/空/含 "*" → 放行 true；否则 value ∈ claim 数组
--   幂等：CREATE OR REPLACE；IMMUTABLE（仅依赖入参，可被 RLS / 索引使用）
-- ============================================================
CREATE OR REPLACE FUNCTION claim_match_or_star(p_claim JSONB, p_value TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_type TEXT;
BEGIN
  -- 缺 claim（NULL / 非数组 JSON）→ 放行（零爆炸半径，兼容旧 token）
  IF p_claim IS NULL OR p_value IS NULL THEN RETURN true; END IF;
  v_type := jsonb_typeof(p_claim);
  IF v_type IS NULL OR v_type = 'null' OR v_type <> 'array' THEN RETURN true; END IF;
  -- 空数组 → 放行
  IF jsonb_array_length(p_claim) = 0 THEN RETURN true; END IF;
  -- 通配 ["*"] → 放行
  IF p_claim @> '"*"'::jsonb THEN RETURN true; END IF;
  -- 精确匹配：value 是否落在 claim 数组里
  RETURN p_claim @> jsonb_build_array(p_value);
END;
$$;
COMMENT ON FUNCTION claim_match_or_star IS 'RLS 四维过滤辅助：claim 缺失/空/含 "*" 放行，否则 value ∈ claim';

-- ============================================================
-- ⑩ get_user_perms 升级（四维合并 + 临时授权 + UI 字段）
--   设计文档 §5 合并优先级：个人 override（最高） > 角色 ∪ 部门
--   返回结构（设计文档 §5 / §6.1）：
--     {role_code, branch_nums, brands, categories, can_see_cost,
--      default_landing, default_metric, visible_panels}
--   分支兜底：
--     - 用户不存在/已禁用 → 全 ["*"] 放行（RLS 缺 claim 放行原则一致）
--     - 用户无 role_id → 角色 UI 字段为 null；数据维度走部门层 + 个人 override
--     - 无任何维度数据 → 维度兜底为 ["*"]（防御性，正常场景不会命中）
--   临时授权：所有 subject_type='user' 条目按 (expires_at IS NULL OR expires_at > NOW()) 过滤后聚合
--   幂等：CREATE OR REPLACE；SECURITY DEFINER + SET search_path（覆盖 015/016 的 VARCHAR 实现）
--   签名：保持 VARCHAR（与 015/016 一致；VARCHAR/TEXT 在 PG 等价，避免重载导致旧迁移 COMMENT 歧义）
--   Breaking change：旧结构 {user_id,user_name,branch_nums,can_see_cost} → 调用方（wecom-oauth/agent-query）在 Task 4/5 适配
-- ============================================================
-- 清理一次性的 TEXT 重载孤儿（早期迭代时 072 曾用 TEXT 签名，与 VARCHAR 在 PG 重载解析里不等价，
-- 留下会让 015/016 的 `COMMENT ON FUNCTION get_user_perms`（无签名）歧义报错；正常 dev 库此 DROP 是 no-op）
DROP FUNCTION IF EXISTS get_user_perms(TEXT);
CREATE OR REPLACE FUNCTION get_user_perms(p_wecom_id VARCHAR) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_id INT;
  v_dept_ids JSONB;
  v_role_code TEXT;
  v_role_landing TEXT;
  v_role_metric TEXT;
  v_role_panels JSONB := '[]'::jsonb;
  v_role_branch JSONB := '[]'::jsonb;
  v_role_brands JSONB := '[]'::jsonb;
  v_role_cats  JSONB := '[]'::jsonb;
  v_role_cost  BOOLEAN := false;
  v_dept_branch JSONB := '[]'::jsonb;
  v_dept_cost   BOOLEAN := false;
  v_user_branch JSONB := '[]'::jsonb;
  v_user_brands JSONB := '[]'::jsonb;
  v_user_cats   JSONB := '[]'::jsonb;
  v_user_cost   BOOLEAN := false;
  v_has_user    BOOLEAN := false;
  v_out_branch JSONB;
  v_out_brands JSONB;
  v_out_cats   JSONB;
  v_out_cost   BOOLEAN;
BEGIN
  -- 0) 找用户 + 角色绑定 + 部门
  SELECT u.role_id, u.department_ids
    INTO v_role_id, v_dept_ids
  FROM org_users u
  WHERE u.wecom_id = p_wecom_id AND u.is_active;

  IF NOT FOUND THEN
    -- 兜底：用户不存在/已禁用 → 全 ["*"] 放行（零爆炸半径，与 RLS 缺 claim 放行一致）
    RETURN jsonb_build_object(
      'role_code', null,
      'branch_nums', '["*"]'::jsonb,
      'brands', '["*"]'::jsonb,
      'categories', '["*"]'::jsonb,
      'can_see_cost', false,
      'default_landing', null,
      'default_metric', null,
      'visible_panels', '[]'::jsonb
    );
  END IF;

  -- 1) 角色底座：UI 字段 + data_permissions(subject_type='role')
  IF v_role_id IS NOT NULL THEN
    SELECT r.code, r.default_landing, r.default_metric, r.visible_panels
      INTO v_role_code, v_role_landing, v_role_metric, v_role_panels
    FROM roles r
    WHERE r.id = v_role_id AND r.is_active;

    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_role_branch
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'role' AND dp.subject_id = v_role_id::text
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_role_brands
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'role' AND dp.subject_id = v_role_id::text
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_role_cats
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'role' AND dp.subject_id = v_role_id::text
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(bool_or(dp.can_see_cost), false) INTO v_role_cost
    FROM data_permissions dp
    WHERE dp.subject_type = 'role' AND dp.subject_id = v_role_id::text
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  END IF;

  -- 2) 部门补充：org_departments.branch_nums / can_see_cost 聚合（并集 / 任一 true）
  IF v_dept_ids IS NOT NULL
     AND jsonb_typeof(v_dept_ids) = 'array'
     AND jsonb_array_length(v_dept_ids) > 0 THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb),
           coalesce(bool_or(d.can_see_cost), false)
      INTO v_dept_branch, v_dept_cost
    FROM org_departments d
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(d.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE d.id::text IN (SELECT jsonb_array_elements_text(v_dept_ids))
      AND d.is_active;
  END IF;

  -- 3) 个人 override（subject_type='user'，含临时授权）：聚合所有生效条目
  SELECT count(*) > 0 INTO v_has_user
  FROM data_permissions dp
  WHERE dp.subject_type = 'user' AND dp.subject_id = p_wecom_id
    AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

  IF v_has_user THEN
    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_user_branch
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.branch_nums, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'user' AND dp.subject_id = p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_user_brands
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.brands, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'user' AND dp.subject_id = p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(jsonb_agg(DISTINCT n.e), '[]'::jsonb)
      INTO v_user_cats
    FROM data_permissions dp
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(dp.categories, '[]'::jsonb)) AS n(e)
    WHERE dp.subject_type = 'user' AND dp.subject_id = p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());

    SELECT coalesce(bool_or(dp.can_see_cost), false) INTO v_user_cost
    FROM data_permissions dp
    WHERE dp.subject_type = 'user' AND dp.subject_id = p_wecom_id
      AND (dp.expires_at IS NULL OR dp.expires_at > NOW());
  END IF;

  -- 4) 合并输出：个人命中 → 个人；否则 角色 ∪ 部门
  IF v_has_user THEN
    v_out_branch := v_user_branch;
    v_out_brands := v_user_brands;
    v_out_cats   := v_user_cats;
    v_out_cost   := v_user_cost;
  ELSE
    -- branch_nums: 角色 ∪ 部门（去重；含 "*" → 全放行）
    SELECT coalesce(jsonb_agg(DISTINCT e), '[]'::jsonb)
      INTO v_out_branch
    FROM jsonb_array_elements_text(v_role_branch || v_dept_branch) AS e;
    -- brands / categories: 仅角色层（部门无 brand/category 维度，设计文档 §4.4 保留部门仅作 branch+cost 补充）
    v_out_brands := v_role_brands;
    v_out_cats   := v_role_cats;
    -- can_see_cost: 角色 OR 部门
    v_out_cost   := v_role_cost OR v_dept_cost;
  END IF;

  -- 含 "*" → 收敛为单一 ["*"]（避免 ["*", "1", "2"] 这种冗余表示）
  IF v_out_branch @> '"*"'::jsonb THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF v_out_brands @> '"*"'::jsonb THEN v_out_brands := '["*"]'::jsonb; END IF;
  IF v_out_cats   @> '"*"'::jsonb THEN v_out_cats   := '["*"]'::jsonb; END IF;

  -- 维度空数组兜底为 ["*"]（防御性；schema DEFAULT '["*"]' 下不应命中）
  IF jsonb_array_length(v_out_branch) = 0 THEN v_out_branch := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_brands) = 0 THEN v_out_brands := '["*"]'::jsonb; END IF;
  IF jsonb_array_length(v_out_cats)   = 0 THEN v_out_cats   := '["*"]'::jsonb; END IF;

  RETURN jsonb_build_object(
    'role_code',       v_role_code,
    'branch_nums',     v_out_branch,
    'brands',          v_out_brands,
    'categories',      v_out_cats,
    'can_see_cost',    v_out_cost,
    'default_landing', v_role_landing,
    'default_metric',  v_role_metric,
    'visible_panels',  v_role_panels
  );
END;
$$;
COMMENT ON FUNCTION get_user_perms(VARCHAR) IS '权限合并 RPC：个人 override（最高） > 角色 ∪ 部门；含临时授权时效判定；返回四维 + 角色 UI 字段';

-- ============================================================
-- ⑪ 权限授予（anon/authenticated；网关与登录流用 service key 调）
-- ============================================================
GRANT EXECUTE ON FUNCTION claim_match_or_star(JSONB, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_user_perms(VARCHAR) TO anon, authenticated;

-- ============================================================
-- ⑫ 重建 report_daily_sales_v / report_daily_category_v 加四维过滤（设计文档 §7.1）
--   维度：branch_nums（门店）+ brands（system_book_code 品牌）+ categories（品类，仅 category_v）+ can_see_cost（成本脱敏 CASE）
--   语义：
--     - current_setting('request.jwt.claims.<key>', true) 缺失/不在 token 中 → 返回 NULL
--     - claim_match_or_star(NULL, ...) → 放行 true（零爆炸半径，旧 token 不破坏）
--     - claim 为 ["*"] 或空数组 → 放行
--     - 否则 value ∈ claim 数组才可见
--   脱敏：total_profit 按 can_see_cost boolean 决定（沿用 045 的 CASE 模式，生产有效）
--   幂等：视图用 DROP+CREATE（CLAUDE.md 坑：CREATE OR REPLACE 给视图加列后重跑报 cannot drop columns from view）
--   行级安全：security_invoker=true → 视图以调用者身份运行，叠加基表 RLS（report_rls_branch_nums）双层过滤
-- ============================================================
DROP VIEW IF EXISTS report_daily_sales_v;
CREATE VIEW report_daily_sales_v AS
SELECT s.biz_date, s.system_book_code, s.branch_num, s.branch_name,
       s.total_orders, s.total_items, s.total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN s.total_profit ELSE NULL END AS total_profit
FROM report_daily_sales s
WHERE claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text)
  AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code);
ALTER VIEW report_daily_sales_v OWNER TO postgres;
ALTER VIEW report_daily_sales_v SET (security_invoker = true);
COMMENT ON VIEW report_daily_sales_v IS '每日门店销售汇总安全视图：四维过滤(branch_nums+brands+can_see_cost 脱敏)；claim 缺失=放行兜底';
GRANT SELECT ON report_daily_sales_v TO authenticated, anon;

DROP VIEW IF EXISTS report_daily_category_v;
CREATE VIEW report_daily_category_v AS
SELECT c.biz_date, c.system_book_code, c.branch_num, c.category,
       c.total_items, c.total_sale,
       CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
            THEN c.total_profit ELSE NULL END AS total_profit
FROM report_daily_category c
WHERE claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, c.branch_num::text)
  AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, c.system_book_code)
  AND claim_match_or_star(current_setting('request.jwt.claims.categories', true)::jsonb, c.category::text);
ALTER VIEW report_daily_category_v OWNER TO postgres;
ALTER VIEW report_daily_category_v SET (security_invoker = true);
COMMENT ON VIEW report_daily_category_v IS '每日门店品类汇总安全视图：四维过滤(branch_nums+brands+categories+can_see_cost 脱敏)；claim 缺失=放行兜底';
GRANT SELECT ON report_daily_category_v TO authenticated, anon;

COMMIT;

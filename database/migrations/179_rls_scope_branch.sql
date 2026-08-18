-- 179_rls_scope_branch.sql
-- W3 / spec 全局约束 6·enforce 机制（redteam-lite M1 封口，方案①策略分支——spec 终审钉死）。
-- 形状鉴别器：request.jwt.claims.data_scope 存在（114 扁平后为顶层 GUC，jsonb）→ 新 claims 路径
--   （空段=deny，B1）；缺失 → 回退 legacy claim_match_or_star（072 原语义，含空数组→true 的
--   legacy 宽松支——仅旧形状令牌可触发，S4 豁免窗口，W4 切走后回退支由 Task 20 删除）。
-- ★严禁对本函数的 data_scope 分支使用 claim_match_or_star（其空数组/NULL→true 全放，M1）。
--
-- 与 plan（docs/superpowers/plans/2026-08-16-platform-iam-standardization.md Task 12）的三处差异，均为对仓库实况的适配：
-- ① claim_match_or_star 实际签名 = (p_claim jsonb, p_value text)（072），回退支按真实签名/顺序调用
--   （plan 伪代码 claim_match_or_star(p_col, p_dim) 参数序反、类型不符）；
-- ② claims 解析失败 / data_scope 维度非数组 → 显式 RETURN FALSE（fail closed，deny 方向安全侧）；
-- ③ 策略清单来自 dev 库 pg_policies + 015/046/058/107 迁移源全量清点（10 条四维策略，均为内联同语义
--   表达式——qual 不含 claim_match_or_star 字面量）；门店维双格式 OR 调用见下。

-- ============================================
-- 1. scope_match_v2(p_dim, p_col)：形状鉴别器（M1 封口核心）
--    p_dim：claims 维度段名（'branch_nums' / 'brands' / 'categories'）
--    p_col：行上待匹配的列值表达式（门店维 = branch_number 全局唯一键——门店键铁律；品牌维 = system_book_code）
-- ============================================
CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_val    TEXT;
BEGIN
  -- claims 整体解析：无 token（NULL/空串）或异常 token（非 JSON）→ fail closed（deny，M1 安全侧）
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 新 claims 分支：data_scope 段存在 → 只认 data_scope（空=deny）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NOT NULL THEN
    v_dim := v_scope -> p_dim;
    IF v_dim IS NULL THEN
      RETURN FALSE;                     -- 段存在但维度缺失 = deny（禁回退——形状已判新）
    END IF;
    IF jsonb_typeof(v_dim) <> 'array' OR jsonb_array_length(v_dim) = 0 THEN
      RETURN FALSE;                     -- 非数组 / ★空数组 = authorized ∅ = deny（B1；072 在此返回 true，禁用之）
    END IF;
    IF v_dim ? '*' THEN
      RETURN TRUE;                      -- 通配放行（语义保留，["*"] 或含 *）
    END IF;
    -- 行级精确匹配：p_col 列值 ∈ data_scope 数组
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;

  -- legacy 分支：无 data_scope 段 → 072 旧语义（NULL/空数组→true 宽松支仅此可达，S4）
  RETURN claim_match_or_star(v_claims -> p_dim, p_col);
END;
$$;

COMMENT ON FUNCTION scope_match_v2 IS 'W3 M1 封口形状鉴别器：claims.data_scope 存在→只认之（空段/缺维/非数组=deny，* 放行，值精确匹配）；缺失→回退 claim_match_or_star 072 旧语义（S4 豁免窗口，Task 20 删）';

GRANT EXECUTE ON FUNCTION scope_match_v2(TEXT, TEXT) TO anon, authenticated;

-- ============================================
-- 2. 行级 RLS 策略全量替换为 scope_match_v2（幂等：DROP IF EXISTS + CREATE）
--    清单来源 = 015/046/058/107 的四维消费位（branch_nums/brands），共 10 条；
--    与旧内联式（NULL/`*`/精确 三支）的差异即 M1 封口：data_scope 存在时空集收敛为 deny。
--
--    门店维（7 表）双格式 OR 调用：
--      · scope_match_v2('branch_nums', branch_num)——裸 branch_num 支 = 015/046/058 legacy 现状语义原样保留
--        （legacy 顶层 claims.branch_nums 值为裸门店号——072/015 按 s.branch_num 匹配）；
--      · scope_match_v2('branch_nums', sbc || '-' || branch_num)——branch_number 支接新形状
--        （T11 产出的 data_scope.branch_nums = branch_number 全局唯一键，门店键铁律）。
--      两支各自独立做形状鉴别：新令牌裸支不命中（值域不同）、空集时两支同 deny，B1 语义不受 OR 稀释。
--
--    品牌维（3 表，107）：USING scope_match_v2('brands', system_book_code)。
--      ⚠ 已知语义差异（S4 窗口内接受，Task 20 收口）：legacy 令牌顶层 brands 缺失时
--      claim_match_or_star(NULL)→true 放行，比 107 的「branch_nums 经 dim_branch 展开限品牌」宽
--      （data_permissions 部门级 brands 恒 NULL，实际影响 = 部门收窄用户/agent-query 代签令牌
--      直查品牌粒度表时不再限品牌；视图层 072 对这类令牌本就全放）。
-- ============================================

-- 2.1 门店粒度 5 表（015：sales/category/weekly_trend；058：delivery/wholesale）
DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_sales;
CREATE POLICY report_rls_branch_nums ON report_daily_sales FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_category;
CREATE POLICY report_rls_branch_nums ON report_daily_category FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_weekly_trend;
CREATE POLICY report_rls_branch_nums ON report_weekly_trend FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_delivery;
CREATE POLICY report_rls_branch_nums ON report_daily_delivery FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

DROP POLICY IF EXISTS report_rls_branch_nums ON report_daily_wholesale;
CREATE POLICY report_rls_branch_nums ON report_daily_wholesale FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

-- 2.2 targets / target_snapshots（046）
DROP POLICY IF EXISTS targets_rls_branch_nums ON targets;
CREATE POLICY targets_rls_branch_nums ON targets FOR SELECT TO authenticated
  USING (
    scope_match_v2('branch_nums', branch_num)
    OR scope_match_v2('branch_nums', system_book_code || '-' || branch_num)
  );

DROP POLICY IF EXISTS snapshots_rls_branch_nums ON target_snapshots;
CREATE POLICY snapshots_rls_branch_nums ON target_snapshots FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM targets t
      WHERE t.id = target_snapshots.target_id
        AND (
          scope_match_v2('branch_nums', t.branch_num)
          OR scope_match_v2('branch_nums', t.system_book_code || '-' || t.branch_num)
        )
    )
  );

-- 2.3 品牌粒度 3 表（107：item_sales / item_outbound / wholesale_customer）
DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_sales;
CREATE POLICY report_rls_brand ON report_daily_item_sales FOR SELECT TO authenticated
  USING (scope_match_v2('brands', system_book_code));

DROP POLICY IF EXISTS report_rls_brand ON report_daily_item_outbound;
CREATE POLICY report_rls_brand ON report_daily_item_outbound FOR SELECT TO authenticated
  USING (scope_match_v2('brands', system_book_code));

DROP POLICY IF EXISTS report_rls_brand ON report_daily_wholesale_customer;
CREATE POLICY report_rls_brand ON report_daily_wholesale_customer FOR SELECT TO authenticated
  USING (scope_match_v2('brands', system_book_code));

-- 3. 全量清点断言（重放时自检）：行级策略 qual 中不得再出现 claim_match_or_star
--    （消费位已全部收敛到 scope_match_v2；视图层 generated/*.sql 的 claim_match_or_star
--     属 Task 16 范围，不在本迁移。）
DO $$
DECLARE
  v_left BIGINT;
BEGIN
  SELECT count(*) INTO v_left FROM pg_policies WHERE qual LIKE '%claim_match_or_star%';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'migration 179: % policy(ies) still reference claim_match_or_star', v_left;
  END IF;
  RAISE NOTICE 'migration 179: scope_match_v2 armed, 0 legacy policy refs';
END $$;

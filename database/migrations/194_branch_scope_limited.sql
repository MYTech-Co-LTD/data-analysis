-- 194：聚合层目标按门店范围收缩（2026-08-18，郑欣案例排查结论）
--
-- 问题：视图层分子（实际值）全部走 scope_match_v2 裁剪，但分母（目标值）只有门店粒度裁剪；
--       总目标 / war_zone / region_l2 级目标行 branch_num='ALL'，经 permFilterTarget
--       「ALL 汇总行恒可见」豁免被原样读出 → 受限用户（如店长/片区 manager）看到
--       全司目标 ÷ 裁剪后实际 的失真达成率（如 2.7%），且战区外层目标 ≠ 展开门店合计。
--
-- 方案（用户裁决 A）：
--   · sale / delivery 等有门店级分解的目标：受限用户改用「可见门店目标之和」（= 展开合计）；
--     全权用户（branch_nums 含 '*'）保持预算原值（war_zone 预算与门店之和本就不严格相等，不硬替换）。
--   · outbound_amt / outbound_profit / 品类目标：数据模型无门店级分解，无从收缩 →
--     受限用户隐藏达成率（rate 置 NULL），只展示实际值。
--
-- 本迁移提供判定函数 branch_scope_limited()：branch 维是否受限（非通配）。
-- 口径与 scope_match_v2（186/193）对齐：无 token / 无 data_scope 段 = deny = 受限；
-- data_scope.branch_nums 或 request.jwt.claims.x_grants.branch_nums 含 '*' = 全权。

CREATE OR REPLACE FUNCTION branch_scope_limited()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_claims jsonb;
  v_grants jsonb;
  v_dim jsonb;
BEGIN
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN TRUE;  -- 坏 token = deny（B1）→ 视为受限
  END;

  -- 无 token / 旧形状令牌（无 data_scope 段）= deny → 受限
  IF v_claims IS NULL OR v_claims -> 'data_scope' IS NULL THEN
    RETURN TRUE;
  END IF;

  v_dim := v_claims -> 'data_scope' -> 'branch_nums';
  IF v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array' THEN
    RETURN TRUE;  -- 非数组 = deny
  END IF;

  -- 通配在任一侧（data_scope 或 x_grants）= 全权 → 不受限
  IF COALESCE(v_dim ? '*', false)
     OR COALESCE((v_grants -> 'branch_nums') ? '*', false) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION branch_scope_limited() TO anon, authenticated;

-- 验证断言（幂等重跑安全：函数存在即通过）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'branch_scope_limited') THEN
    RAISE EXCEPTION '194 验证失败：branch_scope_limited 未创建';
  END IF;
END $$;

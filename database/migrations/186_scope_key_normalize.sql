-- 186_scope_key_normalize.sql
-- scope_match_v2 门店复合键尾段前导零归一（2026-08-17 生产 503 修复链第二缺陷）。
-- 依赖：183（scope_match_v2 并集版）→ 185（终版：摘 claim_match_or_star 回退支）。本迁移 CREATE OR REPLACE
--   重建为归一版，签名 (p_dim text, p_col text) 不变——视图依赖不破，migrate.sh 重跑幂等。
--
-- 根因（生产实测 A/B/C 定位，scripts/tests/scope-key-normalize.test.mjs）：
--   gen 视图门店列传裸 branch_num（'58'）或不补零复合（sbc||'-'||branch_num='3120-58'）；
--   PR#13 后 claims.branch_nums 来自 maps_branch_group.branch_number=dim_branch 规范补零复合（'3120-0058'）
--   → 形态漂移 → 所有 gen 视图 actuals 全空（目标值可见、实际值 NULL）。
--
-- 修复语义（比较侧归一，存储侧不动——claims/maps/dim 全保持规范补零形态）：
--   对「^数字-0+数字$」形态的值，尾段去前导零（'3120-0058' ≡ '3120-58' ≡ '3120-058'）；
--   裸值（无 '-'，如 '58'）与 brands 维（'3120'）不参与归一；通配 '*' 不含 '-' 天然不受影响。
--   归一作用于 data_scope 与 x_grants 两侧的 claim 值及 p_col 列值（双侧对称，方向无关）。
--   裸值与复合值仍互不匹配（'58' ≢ '3120-0058'）——裸 branch_num 跨账套不唯一（门店键铁律），不放宽。
BEGIN;

CREATE OR REPLACE FUNCTION public.scope_match_v2(p_dim text, p_col text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $function$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_grants JSONB;
  v_gdim   JSONB;
  v_val    TEXT;
  v_col    TEXT;
BEGIN
  -- claims / x_grants 解析：无 token、非 JSON → fail closed（deny，179/183 语义保持）
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 无 data_scope 段（旧形状令牌）→ deny（185 终版语义保持）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NULL THEN
    RETURN FALSE;
  END IF;

  v_dim  := v_scope -> p_dim;
  v_gdim := v_grants -> p_dim;
  IF (v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array')
     OR (v_gdim IS NOT NULL AND jsonb_typeof(v_gdim) <> 'array') THEN
    RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义保持）
  END IF;
  IF v_dim IS NULL AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- 维度缺失且无例外 = deny
  END IF;
  v_dim := coalesce(v_dim, '[]'::jsonb);
  IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
    RETURN FALSE;                     -- 并集空 = authorized ∅ = deny（B1）
  END IF;
  IF v_dim ? '*' OR v_gdim ? '*' THEN
    RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
  END IF;

  -- 186：复合门店键尾段前导零归一（双侧对称；无 '-' 的值原样通过，regexp 不改写）
  v_col := regexp_replace(p_col, '^([0-9]+)-0+([0-9]+)$', '\1-\2');

  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
    IF regexp_replace(v_val, '^([0-9]+)-0+([0-9]+)$', '\1-\2') = v_col THEN RETURN TRUE; END IF;
  END LOOP;
  FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_gdim)) LOOP
    IF regexp_replace(v_val, '^([0-9]+)-0+([0-9]+)$', '\1-\2') = v_col THEN RETURN TRUE; END IF;
  END LOOP;
  RETURN FALSE;
END;
$function$;

-- 183 先例：GRANT 面向 anon+authenticated 双角色（web 容器经 PostgREST 以 anon 执行）
GRANT EXECUTE ON FUNCTION public.scope_match_v2(text, text) TO anon, authenticated;

-- 回滚口径：CREATE OR REPLACE 回 185 终版函数体（删两处 regexp_replace 归一 + v_col 声明/赋值）。

DO $$ BEGIN RAISE NOTICE 'Migration 186: scope_match_v2 复合门店键尾段前导零归一（双侧对称，claims/maps/dim 存储形态不动）'; END $$;

COMMIT;

-- 183_temporary_grants.sql
-- W5（Task 17）/ B5+M3+M4：临时例外表（app 侧唯一授权数据，IAM 无到期语义 D7）。
-- 依赖：114（pgrst_pre_request 原版——本迁移 CREATE OR REPLACE 扩展，migrate.sh 重跑 114→183 后版本胜出）、
--       179（scope_match_v2 原版——本迁移 CREATE OR REPLACE 重建为并集版，179 的行级策略清单不变仍引用同名函数）。
-- 语义（B5 铁律）：例外不折叠进登录 claims；RLS 通道 = pgrst_pre_request 每请求实查并集 x_grants 段；
--   app 侧（middleware 快判/push/preview）= 5min TTL 缓存实查（web/lib/exception-grants.ts）。
--
-- 与 plan（Task 17）的三处差异，均为对仓库实况的适配（沿用 179 迁移头的勘误先例）：
-- ① scope_match_v2 以本仓 179 版为起点（brief 指定）：保留其 claims 解析 fail-close（非 JSON→deny）、
--    非数组维度 fail-close、claim_match_or_star 真实签名 (p_claim jsonb, p_value text) 回退支
--    （plan 伪代码参数序反、类型不符——179 勘误 ①原文）；x_grants 解析并入同一 fail-close 块；
-- ② GRANT 面向 anon+authenticated 双角色：web 容器经 PostgREST 以 anon 角色执行（INSFORGE_API_KEY=
--    ANON_KEY role=anon，167 §⑤b 同款），plan 版只授 authenticated 会让管理 API / RT 实查 / pre_request
--    内表查询全部 403/静默空（pre_request 异常被吞 → x_grants 恒 '{}'，功能整体失效）；
-- ③ pre_request 对无 sub 令牌也显式清空 x_grants（'{}'）：防「claims 自带顶层 x_grants key」经 114
--    扁平化循环注入例外（签名令牌内伪造面，防御性收口；plan 版仅在 sub 非空分支内写）。
BEGIN;

-- ============================================
-- 1. 临时例外表（写只走管理 API：requireAdmin + 审计 + 上限；撤销 ≤5min 生效）
-- ============================================
CREATE TABLE IF NOT EXISTS temporary_grants (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,            -- = JWT sub（当前 = wecom_id；pre_request 以 claims->>'sub' 精确匹配）
  dim         TEXT NOT NULL CHECK (dim IN ('branch_nums','brands','categories','fields')),
  value       TEXT NOT NULL,            -- branch_number（全局唯一，门店键铁律）/ sbc / 品类 / 'cost'
  expires_at  TIMESTAMPTZ NOT NULL,     -- 到期即失效（无续期语义，续 = 重授）
  revoked_at  TIMESTAMPTZ,              -- 撤销留痕（不物理删）
  granted_by  TEXT NOT NULL,            -- 授予人（审计归因）
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_temp_grants_active ON temporary_grants(user_id)
  WHERE revoked_at IS NULL;
GRANT SELECT, INSERT ON temporary_grants TO anon, authenticated;  -- UPDATE 限撤销列（见下，差异②）
GRANT UPDATE (revoked_at, note) ON temporary_grants TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
COMMENT ON TABLE temporary_grants IS 'W5 临时例外（spec §5.2）：写只走管理 API（requireAdmin+审计+上限）；撤销 ≤5min 生效（健康态）';

-- ============================================
-- 2. pgrst_pre_request 扩展（= 114 版全文 + 例外并集段）
--    每请求实查活跃例外（revoked_at IS NULL AND expires_at > now()）→ GUC request.jwt.claims.x_grants
--    （事务级，与 PostgREST 主查询同事务）；DB 异常 fail-close 为空对象 = 等同无例外。
-- ============================================
CREATE OR REPLACE FUNCTION pgrst_pre_request() RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_raw    TEXT;
  v_claims JSONB;
  k TEXT;
  v TEXT;
  v_sub TEXT;
  v_grants JSONB;
BEGIN
  v_raw := current_setting('request.jwt.claims', true);
  -- 无 token / anon 请求：claims 为空，不设任何子 GUC（114 兜底行为不变）
  IF v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN;
  END IF;
  BEGIN
    v_claims := v_raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN;  -- 非 JSON（异常 token），不炸，交给 PostgREST 自身鉴权（114 行为不变）
  END;
  -- 114 原有：JSON 扁平化成 request.jwt.claims.<key> 事务级 GUC
  FOR k, v IN SELECT key, value::text FROM jsonb_each(v_claims) LOOP
    PERFORM set_config('request.jwt.claims.' || k, v, true);
  END LOOP;

  -- 例外并集段（M3，183 新增）：本地表直查（廉价、行数极少）；
  -- 无 sub → 也显式清空（差异③：覆盖扁平化循环可能写入的 claims 自带 x_grants）；
  -- 查询异常 → fail-close 空对象 = 等同无例外（不兜底放行）。
  v_sub := v_claims ->> 'sub';
  v_grants := NULL;
  IF v_sub IS NOT NULL THEN
    BEGIN
      SELECT jsonb_build_object(
               'branch_nums', coalesce(jsonb_agg(value) FILTER (WHERE dim = 'branch_nums'), '[]'::jsonb),
               'brands',      coalesce(jsonb_agg(value) FILTER (WHERE dim = 'brands'),      '[]'::jsonb),
               'categories',  coalesce(jsonb_agg(value) FILTER (WHERE dim = 'categories'),  '[]'::jsonb),
               'fields',      coalesce(jsonb_agg(value) FILTER (WHERE dim = 'fields'),      '[]'::jsonb))
        INTO v_grants
        FROM temporary_grants
       WHERE user_id = v_sub AND revoked_at IS NULL AND expires_at > now();
    EXCEPTION WHEN OTHERS THEN
      v_grants := NULL;                 -- fail-close：等同无例外
    END;
  END IF;
  PERFORM set_config('request.jwt.claims.x_grants', coalesce(v_grants, '{}'::jsonb)::text, true);
END;
$$;

GRANT EXECUTE ON FUNCTION pgrst_pre_request() TO anon, authenticated;
COMMENT ON FUNCTION pgrst_pre_request IS
  'PostgREST pre-request：114 扁平化 JWT claims + 183 例外并集段（实查 temporary_grants 活跃行 → request.jwt.claims.x_grants，事务级；DB 异常 fail-close 为空对象）';

-- ============================================
-- 3. scope_match_v2 并集版（= 179 版 + x_grants 并集；行级策略清单不变，仍引用本函数）
--    data_scope.<dim> ∪ x_grants.<dim>：并集空 = authorized ∅ = deny（B1，不因例外通道放松）；
--    通配在任一侧 = 放行；data_scope 段存在但维度缺失且无例外 = deny（禁回退——形状已判新）；
--    data_scope 段缺失 → legacy 回退支（claim_match_or_star 072 语义，S4 豁免窗口，Task 20 删）。
-- ============================================
CREATE OR REPLACE FUNCTION scope_match_v2(p_dim TEXT, p_col TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_claims JSONB;
  v_scope  JSONB;
  v_dim    JSONB;
  v_grants JSONB;
  v_gdim   JSONB;
  v_val    TEXT;
BEGIN
  -- claims / x_grants 解析：无 token、非 JSON → fail closed（deny，179 语义保持；x_grants 并入同块）
  BEGIN
    v_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    v_grants := NULLIF(current_setting('request.jwt.claims.x_grants', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  -- 新 claims 分支：data_scope 段存在 → 只认 data_scope ∪ x_grants（并集空=deny，B1）
  v_scope := v_claims -> 'data_scope';
  IF v_scope IS NOT NULL THEN
    v_dim  := v_scope -> p_dim;
    v_gdim := coalesce(v_grants -> p_dim, '[]'::jsonb);
    IF (v_dim IS NOT NULL AND jsonb_typeof(v_dim) <> 'array')
       OR (v_gdim IS NOT NULL AND jsonb_typeof(v_gdim) <> 'array') THEN
      RETURN FALSE;                     -- 非数组 = deny（fail-close，179 语义保持）
    END IF;
    IF v_dim IS NULL AND jsonb_array_length(v_gdim) = 0 THEN
      RETURN FALSE;                     -- 维度缺失且无例外 = deny（禁回退——形状已判新）
    END IF;
    v_dim := coalesce(v_dim, '[]'::jsonb);
    IF jsonb_array_length(v_dim) = 0 AND jsonb_array_length(v_gdim) = 0 THEN
      RETURN FALSE;                     -- ★并集空 = authorized ∅ = deny（B1）
    END IF;
    IF v_dim ? '*' OR v_gdim ? '*' THEN
      RETURN TRUE;                      -- 通配在任一侧 = 放行（语义保留）
    END IF;
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_dim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    FOREACH v_val IN ARRAY ARRAY(SELECT jsonb_array_elements_text(v_gdim)) LOOP
      IF v_val = p_col THEN RETURN TRUE; END IF;
    END LOOP;
    RETURN FALSE;
  END IF;

  -- legacy 分支：无 data_scope 段 → 072 旧语义（NULL/空数组→true 宽松支仅此可达，S4）
  RETURN claim_match_or_star(v_claims -> p_dim, p_col);
END;
$$;

COMMENT ON FUNCTION scope_match_v2 IS
  'W5 并集版：data_scope.<dim> ∪ x_grants.<dim>（例外 RT 实查段）；并集空=deny（B1）、通配任一侧放行；缺 data_scope 段→回退 claim_match_or_star 072 旧语义（S4，Task 20 删）';

GRANT EXECUTE ON FUNCTION scope_match_v2(TEXT, TEXT) TO anon, authenticated;

COMMIT;

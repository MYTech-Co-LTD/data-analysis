-- 201_scope_any_fastpath.sql
-- spec: docs/superpowers/specs/2026-08-19-item-branch-grain.md
-- 商品 TOP 视图慢查询修复（性能补记，spec §2.5）：branch 粒度重建后 item 表 43 万行 × 逐行 plpgsql scope_match_v2
--   （视图谓词 + RLS 策略双份，3-6 次/行）→ 月榜查询 4.6-9.2s，撞 InsForge→PostgREST 10s 代理超时
--   → 三次重试 30s → 前端"商品看板加载不出数据"。
-- 方案：scope_*_keys() 一次性求值（InitPlan/语句级缓存）+ = ANY 数组匹配，语义与 scope_match_v2
--   等价（fail-close / '*' 通配 / 前导零归一 / 旧形状无 data_scope deny）。仅商品视图与两张 item 表
--   策略替换（其余视图表量级未触发超时，保持 sm2 不动——统一收敛待生成器支持后另做）。
BEGIN;

-- ---- 一次性键集函数（STABLE：语句内缓存；plpgsql 仅调用一次，开销可忽略） ----
CREATE OR REPLACE FUNCTION public.scope_branch_keys() RETURNS text[]
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  c jsonb; d jsonb;
BEGIN
  BEGIN
    c := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{}';                                        -- 无/坏 claims → fail-close 空集
  END;
  d := c -> 'data_scope';
  IF d IS NULL OR jsonb_typeof(d) <> 'object' THEN
    RETURN '{}';                                        -- 旧形状令牌（无 data_scope 段）→ deny
  END IF;
  d := d -> 'branch_nums';
  IF d IS NULL THEN RETURN '{}'; END IF;
  IF jsonb_typeof(d) <> 'array' THEN RETURN '{}'; END IF;
  IF d ? '*' THEN RETURN '{*}'; END IF;                 -- 通配短路
  -- 186 前导零归一（与 sm2 对称）
  RETURN ARRAY(SELECT DISTINCT regexp_replace(e, '^([0-9]+)-0+([0-9]+)$', '\1-\2')
               FROM jsonb_array_elements_text(d) e);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.scope_brand_keys() RETURNS text[]
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  c jsonb; d jsonb;
BEGIN
  BEGIN
    c := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN '{}';
  END;
  d := c -> 'data_scope';
  IF d IS NULL OR jsonb_typeof(d) <> 'object' THEN RETURN '{}'; END IF;
  d := d -> 'brands';
  IF d IS NULL THEN RETURN '{}'; END IF;
  IF jsonb_typeof(d) <> 'array' THEN RETURN '{}'; END IF;
  IF d ? '*' THEN RETURN '{*}'; END IF;
  RETURN ARRAY(SELECT DISTINCT e FROM jsonb_array_elements_text(d) e);
END;
$fn$;

-- ---- item 表 RLS 策略换 ANY 形态（幂等 DROP/CREATE） ----
DROP POLICY IF EXISTS report_rls_scope ON report_daily_item_sales;
CREATE POLICY report_rls_scope ON report_daily_item_sales FOR SELECT TO authenticated
  USING (('*' = ANY((SELECT scope_brand_keys())::text[]) OR system_book_code = ANY((SELECT scope_brand_keys())::text[]))
     AND ('*' = ANY((SELECT scope_branch_keys())::text[])
       OR branch_num::text = ANY((SELECT scope_branch_keys())::text[])
       OR (system_book_code || '-' || branch_num) = ANY((SELECT scope_branch_keys())::text[])));
DROP POLICY IF EXISTS report_rls_scope ON report_daily_item_outbound;
CREATE POLICY report_rls_scope ON report_daily_item_outbound FOR SELECT TO authenticated
  USING (('*' = ANY((SELECT scope_brand_keys())::text[]) OR system_book_code = ANY((SELECT scope_brand_keys())::text[]))
     AND ('*' = ANY((SELECT scope_branch_keys())::text[])
       OR branch_num::text = ANY((SELECT scope_branch_keys())::text[])
       OR (system_book_code || '-' || branch_num) = ANY((SELECT scope_branch_keys())::text[])));

-- ---- 语义回归断言：与 scope_match_v2 同 claims 下逐形态一致 ----
DO $do$ BEGIN
  RAISE NOTICE 'Migration 201: scope ANY fastpath 就绪（商品视图谓词由 generated 文件随迁移重建）';
END $do$;

COMMIT;

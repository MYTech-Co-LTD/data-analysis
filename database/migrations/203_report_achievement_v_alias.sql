-- 203_report_achievement_v_alias.sql
-- spec: docs/superpowers/specs/2026-08-20-achievement-view-registry-fix.md
-- 兼容别名：旧名 report_achievement_v 仍可查（会话/模型锚定旧名，技能已引导新名 gen，
-- 别名保证存量会话与习惯查询立即恢复）。视图 = gen 的薄封装，权限语义完全继承
-- （security_invoker + gen 内部 scope_branch_keys/scope_brand_keys/can_cost_visible）。
-- 幂等/重放安全：203 排在 202 之后——每轮全量重放 046 播种 v → 202 清 v → 203 重建别名；
-- 终态 = gen 规范名 + v 兼容别名并存。无 DROP/DELETE，非破坏性。
BEGIN;

-- ① 别名视图：薄封装 gen（PG15 security_invoker 显式声明）
CREATE OR REPLACE VIEW public.report_achievement_v AS
  SELECT * FROM public.report_achievement_gen;
ALTER VIEW public.report_achievement_v SET (security_invoker = true);
ALTER VIEW public.report_achievement_v OWNER TO postgres;
GRANT SELECT ON public.report_achievement_v TO authenticated, anon;

-- ② 注册表登记（202 每轮会删旧行，203 在此重建为真实别名；ON CONFLICT 幂等）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
VALUES (
  'report_achievement_v',
  '目标达成率(兼容别名,旧名)',
  'pg_table',
  'report_achievement_v',
  'summary',
  TRUE, TRUE, 'start_date', 'YYYY-MM-DD', FALSE, TRUE,
  '目标达成率兼容别名（旧名，=report_achievement_gen 同源同权限）；新查询请用 report_achievement_gen'
)
ON CONFLICT (name) DO NOTHING;

-- ③ 列描述：copy 自 gen（保证字典可读；冲突跳过）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT 'report_achievement_v', name, data_type, semantic_group, is_sensitive, join_to, description, ordinal
FROM dataset_columns WHERE dataset_name = 'report_achievement_gen'
ON CONFLICT (dataset_name, name) DO NOTHING;

-- ④ 断言：两个名字都必须存在
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM datasets WHERE name = 'report_achievement_gen') THEN
    RAISE EXCEPTION 'report_achievement_gen missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM datasets WHERE name = 'report_achievement_v') THEN
    RAISE EXCEPTION 'report_achievement_v alias missing';
  END IF;
END $$;

COMMIT;

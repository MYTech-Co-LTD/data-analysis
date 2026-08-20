-- 202_report_achievement_gen_registry.sql
-- spec: docs/superpowers/specs/2026-08-20-achievement-view-registry-fix.md
-- 修复注册表/视图命名漂移：问数（agent-query）查 report_achievement_v 报「表不存在」。
-- 根因：语义层视图生成器已把达成率视图重命名为 report_achievement_gen
--      （前端 targets.ts / push 链路均已切 _gen；视图为 security_invoker + scope_*_keys 权限强制），
--      但数据注册中心 datasets/dataset_columns 与 admin RPC get_targets_admin（048）仍指向旧名
--      report_achievement_v（DB 已无此视图）。
-- 重放安全（migrate.sh 每次全量重放）：046 每次会用 ON CONFLICT DO UPDATE 重新播种 v 行，
--   故本迁移不能只做 rename——必须「INSERT gen（ON CONFLICT DO NOTHING）+ DELETE v」，
--   任意状态下终态一致：只留 report_achievement_gen。
-- 顺序（FK：dataset_columns.dataset_name → datasets.name）：
--   ① 父表 gen 行先建（copy 自 v；v 必然存在——046 刚播种；若缺则由 DO NOTHING 兜底）
--   ② 子表 gen 列 copy（pkey=(dataset_name,name)，ON CONFLICT DO NOTHING）
--   ③ 删 v 子行 → ④ 删 v 父行 → ⑤ RPC 函数体改读新视图
BEGIN;

-- ① 父表：确保 gen 行存在（copy 自 v 的元数据；已存在则跳过）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
SELECT 'report_achievement_gen', display_name, engine, 'report_achievement_gen', kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description
FROM datasets WHERE name = 'report_achievement_v'
ON CONFLICT (name) DO NOTHING;

-- ② 子表：gen 列补齐（与 046 同字段映射；冲突=已存在则跳过）
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT 'report_achievement_gen', name, data_type, semantic_group, is_sensitive, join_to, description, ordinal
FROM dataset_columns WHERE dataset_name = 'report_achievement_v'
ON CONFLICT (dataset_name, name) DO NOTHING;

-- ③ 清理 v 子行（046 重放会再播种，本迁移每次收尾）
DELETE FROM dataset_columns WHERE dataset_name = 'report_achievement_v';

-- ④ 清理 v 父行
DELETE FROM datasets WHERE name = 'report_achievement_v';

-- ⑤ admin RPC：048 函数体仍读旧视图 → 改读新视图（SECURITY DEFINER 语义不变）
CREATE OR REPLACE FUNCTION public.get_targets_admin()
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (SELECT * FROM report_achievement_gen) t;
$$;
GRANT EXECUTE ON FUNCTION public.get_targets_admin() TO authenticated, anon;

-- 验证断言（幂等校验）：新名必须已注册且旧名已清理
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM datasets WHERE name = 'report_achievement_gen') THEN
    RAISE EXCEPTION 'report_achievement_gen not registered in datasets';
  END IF;
  IF EXISTS (SELECT 1 FROM datasets WHERE name = 'report_achievement_v') THEN
    RAISE EXCEPTION 'stale report_achievement_v still in datasets';
  END IF;
END $$;

COMMIT;

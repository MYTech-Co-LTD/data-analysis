-- 202_report_achievement_gen_registry.sql
-- spec: docs/superpowers/specs/2026-08-20-achievement-view-registry-fix.md
-- 修复注册表/视图命名漂移：问数（agent-query）查 report_achievement_v 报「表不存在」。
-- 根因：语义层视图生成器已把达成率视图重命名为 report_achievement_gen
--      （前端 targets.ts / push 链路均已切 _gen；视图为 security_invoker + scope_*_keys 权限强制），
--      但数据注册中心 datasets 行、dataset_columns 关联、admin RPC get_targets_admin（048）
--      仍指向旧名 report_achievement_v（DB 已无此视图）→ 问数表不存在 + admin 目标页 RPC 报错。
-- 修法：三处旧名统一同步为 report_achievement_gen。
-- 顺序要点（FK：dataset_columns.dataset_name → datasets.name ON DELETE CASCADE）：
--   ① 父表先 INSERT 新名行（ON CONFLICT (name) DO NOTHING 幂等）
--   ② 子表 UPDATE 关联到新名
--   ③ 删旧行（此时已无子引用）
--   ④ RPC 函数体改读新视图
-- 幂等：无 DROP、无破坏；可随 migrate.sh 反复重放。
BEGIN;

-- ① 父表：复制旧行建立新名（保留 display_name/engine/kind/exposed/date 等元数据）
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
SELECT 'report_achievement_gen', display_name, engine, 'report_achievement_gen', kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description
FROM datasets WHERE name = 'report_achievement_v'
ON CONFLICT (name) DO NOTHING;

-- ② 子表：关联改到新名
UPDATE dataset_columns SET dataset_name = 'report_achievement_gen'
 WHERE dataset_name = 'report_achievement_v';

-- ③ 删旧行（CASCADE 只会在残留引用时误删子行——此时已全部迁走，安全）
DELETE FROM datasets WHERE name = 'report_achievement_v';

-- ④ admin RPC：048 函数体仍读旧视图 → 改读新视图（SECURITY DEFINER 语义不变）
CREATE OR REPLACE FUNCTION public.get_targets_admin()
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (SELECT * FROM report_achievement_gen) t;
$$;
GRANT EXECUTE ON FUNCTION public.get_targets_admin() TO authenticated, anon;

-- 验证断言（幂等校验）：新名必须已注册
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM datasets WHERE name = 'report_achievement_gen') THEN
    RAISE EXCEPTION 'report_achievement_gen not registered in datasets';
  END IF;
END $$;

COMMIT;

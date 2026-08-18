-- 190_push_var_achievement_rate.sql
-- 生产接线 修复步骤 4：旗舰场景「销售达成率日报」缺推送变量。
--   metric_registry 已有比率指标 sale_rate（= sale_amount / sale_target，formula_ast，迁移 173 后补），
--   但 push_variables 只种了 sale_amount → 模板无法引用达成率。
--   补种 achievement_rate → sale_rate（口径引用 metric_registry，语义层铁律：变量白名单注册表唯一来源）。
-- 幂等：ON CONFLICT (var_code) DO NOTHING + 末尾验证断言。

INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('achievement_rate', '销售达成率', 'sale_rate', 'total', NULL, '%', true),
  -- URL 型变量（render.ts：<code>_url → /report/<view>?…&jwt=<10min 代签>）；
  -- scheduled_report workflow 模板引用 {{payload.detail_url}}（契约①：模板 ⊆ 白名单）
  ('detail_url', '明细链接（10min 代签 JWT）', NULL, 'total', NULL, NULL, true)
-- 2026-08-17 幂等自愈修复：此前 DO NOTHING 遇到半途种的旧行（achievement_rate
-- 存在但 enabled=false）被 CONFLICT 跳过 → 断言挂 → 阻塞部署管线（main CI failure
-- 31996958965）。改 DO UPDATE 自愈口径+启用，重复执行稳定收敛。
ON CONFLICT (var_code) DO UPDATE SET
  name = EXCLUDED.name,
  metric_code = EXCLUDED.metric_code,
  scope_dim = EXCLUDED.scope_dim,
  extra_filter = EXCLUDED.extra_filter,
  unit = EXCLUDED.unit,
  enabled = EXCLUDED.enabled;

-- 验证断言（重复执行幂等：存在且口径正确即通过）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM push_variables
    WHERE var_code = 'achievement_rate' AND metric_code = 'sale_rate' AND enabled
  ) THEN
    RAISE EXCEPTION 'migration 190 failed: achievement_rate not seeded correctly';
  END IF;
  RAISE NOTICE 'Migration 190_push_var_achievement_rate applied';
END $$;

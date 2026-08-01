-- Migration 136: Drop formula TEXT column (AST transition complete)
-- Semantic Layer: 删除过渡期保留的 formula TEXT 列，生成器已完全切换到 formula_ast
--
-- 背景：
-- - 1.4 版本前：生成器解析 formula TEXT 字符串（正则/字符串处理）
-- - 1.4 版本后：生成器读 formula_ast JSONB（AST 递归翻译）
-- - 所有 derived 指标已迁移到 formula_ast（迁移 130）
-- - 生成器代码已删除 formula 引用（2026-08-01）
--
-- 幂等处理：先添加 formula 列（如果不存在），再删除
-- 原因：历史迁移（076-135）引用 formula 列，每次部署重跑时需要此列存在

ALTER TABLE metric_registry ADD COLUMN IF NOT EXISTS formula TEXT;
ALTER TABLE metric_registry DROP COLUMN IF EXISTS formula;

DO $$
BEGIN
  RAISE NOTICE 'Migration 136: formula TEXT 列已删除（AST 化收口）';
END $$;
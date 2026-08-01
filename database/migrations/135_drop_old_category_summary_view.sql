-- Migration 135: Drop old category_summary view
-- Phase 2 Brand-Metric Table: Task 8 - 下线旧视图
--
-- 前端已切换到 report_category_summary_gen（语义层生成视图）
-- 此迁移下线旧的硬编码视图

DROP VIEW IF EXISTS report_category_summary_v;

-- 验证生成视图存在（警告，不阻断）
-- 注意：migrate.sh 执行顺序是 migrations/ → generated/，所以此时视图可能还未创建
DO $$
DECLARE
    col_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'report_category_summary_gen';

    IF col_count = 0 THEN
        RAISE NOTICE 'report_category_summary_gen 视图尚未创建（将在 generated/ 步骤创建）';
    ELSIF col_count != 13 THEN
        RAISE WARNING 'report_category_summary_gen 视图列数不对（期望 13，实际 %）', col_count;
    ELSE
        RAISE NOTICE 'report_category_summary_gen 视图验证通过（13 列）';
    END IF;
END $$;
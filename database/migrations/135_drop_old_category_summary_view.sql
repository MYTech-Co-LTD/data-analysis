-- Migration 135: Drop old category_summary view
-- Phase 2 Brand-Metric Table: Task 8 - 下线旧视图
--
-- 前端已切换到 report_category_summary_gen（语义层生成视图）
-- 此迁移下线旧的硬编码视图

DROP VIEW IF EXISTS report_category_summary_v;

-- 验证生成视图存在且列正确
DO $$
DECLARE
    col_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO col_count
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'report_category_summary_gen';

    IF col_count != 13 THEN
        RAISE EXCEPTION 'report_category_summary_gen 视图列数不对（期望 13，实际 %）', col_count;
    END IF;
END $$;
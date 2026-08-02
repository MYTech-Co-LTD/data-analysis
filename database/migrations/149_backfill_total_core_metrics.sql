-- 149_backfill_total_core_metrics.sql
-- 修 bug：8 月经营目标(823) 在管理后台列表里消失。
-- 根因：823 创建于 2026-08-01 13:56，早于 137(upsert_target_total 自动插 4 指标) 部署，
--   走了旧的"建空目标"路径 → 0 个 target_metric_values → 被 report_achievement_v
--   (get_targets_admin 数据源) 排除 → 管理列表看不到该目标。
-- 修复：给所有 total 目标回填缺失的 4 核心指标(sale/delivery/outbound_amt/outbound_profit)，
--   target_value=0（同 137 的空值语义；用户随后在分解页配置覆盖）。
-- 幂等：NOT EXISTS 只补缺失行，重跑 no-op。新目标经 137 已自动插，本迁移仅兜底历史遗漏。

INSERT INTO target_metric_values (target_id, metric_code, target_value)
SELECT t.id, m.metric_code, 0
FROM targets t
CROSS JOIN (VALUES ('sale'), ('delivery'), ('outbound_amt'), ('outbound_profit')) AS m(metric_code)
WHERE t.target_level = 'total'
  AND NOT EXISTS (
    SELECT 1 FROM target_metric_values tmv
    WHERE tmv.target_id = t.id AND tmv.metric_code = m.metric_code
  );

DO $$ BEGIN RAISE NOTICE 'Migration 149: 回填 total 目标缺失的核心指标（修早于 137 创建的目标从管理列表消失）'; END $$;

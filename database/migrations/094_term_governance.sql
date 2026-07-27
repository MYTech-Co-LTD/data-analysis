-- 094_term_governance.sql
-- 术语治理（仅 metric_definitions）：delivery 统一「配送」（不再叫出库），outbound 专指「出库」(=配送+批发)
--
-- 范围说明：
--   metric_registry 已由 088_metric_restructure.sql（指标体系重构：delivery=总部→熊喵门店调拨；
--   distribution=配送合计 delivery+wholesale_pp；outbound=出库 delivery+wholesale_pp+wholesale_ext）
--   + 089_delivery_name_fix.sql（delivery_amount→「配送-熊喵门店金额」、delivery_profit→「配送-熊喵门店毛利」，
--   与 distribution_*「配送金额/配送毛利」消歧）治理完毕，当前术语全部正确
--   （销售 / 配送-熊喵门店 / 批发 / 配送金额 / 出库金额）。
--   本迁移**不动 metric_registry**，以免与 distribution_* 撞名、破坏 089 消歧。
--   仅同步 metric_definitions.name（智能问数 metric_name 显示用，068 旧名仍为
--   门店零售/门店配送/总仓出库金额/总仓出库毛利）到统一术语。
-- 幂等：纯 UPDATE。migrate.sh 按文件名重跑，094 在 068 之后执行、覆盖其 seed 值。

UPDATE metric_definitions SET name='销售'   WHERE metric_code='sale';
UPDATE metric_definitions SET name='配送'   WHERE metric_code='delivery';
UPDATE metric_definitions SET name='出库金额' WHERE metric_code='outbound_amt';
UPDATE metric_definitions SET name='出库毛利' WHERE metric_code='outbound_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 094_term_governance completed: metric_definitions(4) synced; metric_registry untouched (governed by 088/089)'; END $$;

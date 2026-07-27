-- 094_term_governance.sql
-- 术语治理：delivery 统一「配送」（不再叫出库），outbound 专指「出库」(=配送+批发)
-- 同步 metric_definitions.name（智能问数 metric_name 显示用）+ metric_registry.name（语义层）
-- 修 metric_registry 里 delivery_amount='出库金额' 与 outbound_amount 撞名的 bug
-- 幂等：纯 UPDATE。migrate.sh 按文件名重跑，094 在 068/076/088/089 之后执行、覆盖其 seed 值。

UPDATE metric_definitions SET name='销售'   WHERE metric_code='sale';
UPDATE metric_definitions SET name='配送'   WHERE metric_code='delivery';
UPDATE metric_definitions SET name='出库金额' WHERE metric_code='outbound_amt';
UPDATE metric_definitions SET name='出库毛利' WHERE metric_code='outbound_profit';

UPDATE metric_registry SET name='配送金额' WHERE metric_code='delivery_amount';
UPDATE metric_registry SET name='配送毛利' WHERE metric_code='delivery_profit';

DO $$ BEGIN RAISE NOTICE 'Migration 094_term_governance completed'; END $$;

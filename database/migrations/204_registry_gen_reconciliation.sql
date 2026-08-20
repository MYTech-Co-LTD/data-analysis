-- 204_registry_gen_reconciliation.sql
-- spec: docs/superpowers/specs/2026-08-20-registry-gen-reconciliation.md
-- 注册表全面对账（承接 202/203 暴露的系统性问题）：语义层生成器已把所有报表视图命名为
--   report_*_gen（前端 web/lib/report-center、push 链路全部用 _gen），且每次部署 generated
--   步骤会 DROP VIEW ... _gen CASCADE——任何依赖 _gen 的旧名别名视图（如 203 建的
--   report_achievement_v = SELECT * FROM gen）都会被级联删除，别名方案与生成器架构冲突，废弃。
-- 正解：注册表直接指向真实对象（_gen 视图 / RLS 基础表），不再造别名。
-- 处理清单：
--   A. 旧名注册 → 真实对象：
--      report_region_breakdown_v → report_region_breakdown_gen（战区下钻，本次用户故障点）
--      report_category_summary_v → report_category_summary_gen
--      report_daily_sales_v      → report_daily_sales（RLS 基础表，exposed 置 true）
--      report_daily_category_v   → report_daily_category（RLS 基础表，exposed 置 true）
--      report_achievement_v      → 删除注册 + DROP 别名视图（155 已按设计下线，CASCADE 每轮会删）
--   B. 补注册缺失的生成视图（均带 scope_branch_keys 权限强制，与前端同源）：
--      report_brand_metric_gen / report_category_summary_gen / report_item_breakdown_gen /
--      report_region_breakdown_gen / report_supply_chain_outbound_gen /
--      report_wholesale_customer_gen / report_wholesale_daily_customer_gen / report_wholesale_daily_gen
--   C. 列描述统一从 information_schema 播种（is_sensitive: 名称含 cost/profit/margin/price）。
-- 幂等/重放安全：204 排在 203 之后；032 每轮播种旧 _v 注册 → 204 每轮收拢到真实对象；
-- 145→155 区域在 204 之前执行，无冲突。
BEGIN;

-- ========== A. 旧名 → 真实对象（先建父行 → 迁子列 → 删旧行，FK 安全） ==========

-- A1. report_region_breakdown_v → report_region_breakdown_gen
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
SELECT 'report_region_breakdown_gen', '门店零售出库下钻(战区/区域/门店)', 'pg_table', 'report_region_breakdown_gen', 'summary', TRUE, TRUE, NULL, NULL, FALSE, TRUE,
       '门店零售/出库数据报表（大区→小区→门店三层下钻；scope_branch_keys 行级裁剪）'
FROM datasets WHERE name = 'report_region_breakdown_v'
ON CONFLICT (name) DO NOTHING;
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT 'report_region_breakdown_gen', name, data_type, semantic_group, is_sensitive, join_to, description, ordinal
FROM dataset_columns WHERE dataset_name = 'report_region_breakdown_v'
ON CONFLICT (dataset_name, name) DO NOTHING;
DELETE FROM datasets WHERE name = 'report_region_breakdown_v';

-- A2. report_category_summary_v → report_category_summary_gen
INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
SELECT 'report_category_summary_gen', '类别出库汇总(生成视图)', 'pg_table', 'report_category_summary_gen', 'summary', TRUE, TRUE, NULL, NULL, FALSE, TRUE,
       '仓储出库数据报表（水果/标品/耗材/合计；scope_branch_keys 行级裁剪）'
FROM datasets WHERE name = 'report_category_summary_v'
ON CONFLICT (name) DO NOTHING;
INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
SELECT 'report_category_summary_gen', name, data_type, semantic_group, is_sensitive, join_to, description, ordinal
FROM dataset_columns WHERE dataset_name = 'report_category_summary_v'
ON CONFLICT (dataset_name, name) DO NOTHING;
DELETE FROM datasets WHERE name = 'report_category_summary_v';

-- A3. report_daily_sales_v：删除死注册（155 已 DROP；040 守卫禁查基础表，日报走 retail_detail 明细
--     或 report_region_breakdown_gen 的 daily_sale 列；基础表保持不暴露）
DELETE FROM datasets WHERE name = 'report_daily_sales_v';
UPDATE datasets SET exposed = FALSE WHERE name = 'report_daily_sales';

-- A4. report_daily_category_v：同上（品类汇总走 report_category_summary_gen）
DELETE FROM datasets WHERE name = 'report_daily_category_v';
UPDATE datasets SET exposed = FALSE WHERE name = 'report_daily_category';

-- A5. report_achievement_v：删除注册 + DROP 别名视图（依赖 gen 会被 generated CASCADE 删，别名方案废弃）
DROP VIEW IF EXISTS report_achievement_v;
DELETE FROM datasets WHERE name = 'report_achievement_v';

-- ========== B. 补注册缺失生成视图（全部 scope_branch_keys 强制，与前端同源） ==========

-- 列播种辅助：从 information_schema 取真实列；is_sensitive = 名称含 cost/profit/margin/price
DO $$
DECLARE
  v_view text;
  v_views text[] := ARRAY[
    'report_brand_metric_gen', 'report_category_summary_gen', 'report_item_breakdown_gen',
    'report_region_breakdown_gen', 'report_supply_chain_outbound_gen', 'report_wholesale_customer_gen',
    'report_wholesale_daily_customer_gen', 'report_wholesale_daily_gen'
  ];
BEGIN
  FOREACH v_view IN ARRAY v_views LOOP
    -- 数据集行（已由 A/B 段确保存在；此处兜底）
    INSERT INTO datasets (name, display_name, engine, source, kind, is_realtime, columns_typed, date_column, date_format, carry_enabled, exposed, description)
    VALUES (v_view, v_view, 'pg_table', v_view, 'summary', TRUE, TRUE, NULL, NULL, FALSE, TRUE, '生成报表视图（scope_branch_keys 行级裁剪；与前端同源）')
    ON CONFLICT (name) DO NOTHING;
    -- 列
    INSERT INTO dataset_columns (dataset_name, name, data_type, semantic_group, is_sensitive, join_to, description, ordinal)
    SELECT v_view, column_name, data_type, NULL,
           (column_name ~* '(cost|profit|margin|price)') AS is_sensitive, NULL, NULL, ordinal_position
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_view
    ON CONFLICT (dataset_name, name) DO NOTHING;
  END LOOP;
END $$;

-- ========== C. 断言 ==========
DO $$
DECLARE
  v_bad int;
BEGIN
  -- 所有 exposed pg_table 注册必须能解析到真实 DB 对象
  SELECT count(*) INTO v_bad FROM datasets d
   WHERE d.engine = 'pg_table' AND d.exposed
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables t
                     WHERE t.table_schema = 'public' AND t.table_name = d.name);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% exposed pg_table dataset(s) point to missing DB objects', v_bad;
  END IF;
END $$;

COMMIT;

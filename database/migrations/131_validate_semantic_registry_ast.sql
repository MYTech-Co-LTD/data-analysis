-- 131_validate_semantic_registry_ast.sql
-- 扩展 validate_semantic_registry：加 AST ref 闭环校验
-- derived formula_ast 的所有 ref 节点：metric_code 必须在 registry（enabled）或窗口列集合，
-- 否则报 issue。防 formula_ast 引用不存在的 metric（生成器 resolveRef 会 throw，但 L1 在部署期更早抓）。
-- 幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest。

CREATE OR REPLACE FUNCTION validate_semantic_registry() RETURNS TABLE(issue TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 1) base measure 的 fact_table 必须注册在 datasets（明细 parquet）或为 PG 表
  RETURN QUERY
    SELECT format('base 指标 %s 的 fact_table %s 未注册 datasets 且非 PG 表',
      m.metric_code, m.fact_table)
    FROM metric_registry m
    WHERE m.measure_type = 'base' AND m.enabled
      AND m.fact_table NOT IN (SELECT name FROM datasets)
      AND m.fact_table NOT IN (
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      );

  -- 2) derived measure 的 depends_on 必须全部存在于 registry（闭环）
  RETURN QUERY
    SELECT format('derived 指标 %s 依赖未定义指标 %s', m.metric_code, dep)
    FROM metric_registry m
    CROSS JOIN LATERAL jsonb_array_elements_text(m.depends_on) AS dep
    WHERE m.measure_type = 'derived' AND m.enabled
      AND dep NOT IN (SELECT metric_code FROM metric_registry WHERE enabled);

  -- 3) static 维度的 join_key 必须存在于 join_table
  RETURN QUERY
    SELECT format('维度 %s 的 join_key %s 不在表 %s', d.dim_code, d.join_key, d.join_table)
    FROM dimensions d
    WHERE d.source_type = 'static' AND d.enabled
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = d.join_table AND c.column_name = d.join_key
      );

  -- 4) static 维度的层级 key_column 必须存在于 join_table
  RETURN QUERY
    SELECT format('维度 %s 层级 %s 的 key_column %s 不在表 %s',
      dl.dim_code, dl.level_code, dl.key_column, d.join_table)
    FROM dimension_levels dl
    JOIN dimensions d ON d.dim_code = dl.dim_code
    WHERE d.source_type = 'static' AND d.enabled
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = d.join_table AND c.column_name = dl.key_column
      );

  -- 5) derived formula_ast 的 ref 节点：metric_code 必须在 registry（enabled）或窗口列集合
  --    窗口列：total_days/days_elapsed/latest_day/current_date（tgt CTE 产物，非 metric）
  RETURN QUERY
    SELECT DISTINCT format('derived 指标 %s 的 formula_ast 引用未定义 metric/窗口列 %s', m.metric_code, ref_code)
    FROM metric_registry m
    CROSS JOIN LATERAL jsonb_path_query(m.formula_ast, '$.**.code') AS ref_val
    CROSS JOIN LATERAL (SELECT ref_val #>> '{}' AS ref_code) rc
    WHERE m.measure_type = 'derived' AND m.enabled AND m.formula_ast IS NOT NULL
      AND ref_code NOT IN (SELECT metric_code FROM metric_registry WHERE enabled)
      AND ref_code NOT IN ('total_days','days_elapsed','latest_day','current_date');

  RETURN;
END;
$$;

COMMENT ON FUNCTION validate_semantic_registry() IS '语义层静态校验：base fact_table/derived depends_on 闭环/维度 join_key/formula_ast ref 闭环。返回问题列表，空=全通过。部署后应跑';
GRANT EXECUTE ON FUNCTION validate_semantic_registry() TO postgres, authenticated;

DO $$ BEGIN RAISE NOTICE 'Migration 131: validate_semantic_registry 加 formula_ast ref 闭环校验'; END $$;

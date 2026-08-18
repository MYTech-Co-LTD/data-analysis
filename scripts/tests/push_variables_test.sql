-- scripts/tests/push_variables_test.sql
-- U5a push_variables 注册表失败测试（plan Task 7 / spec §5.1）。
-- 运行：scratch 库应用核心链（076 metric_registry）+ 173_push_variables 后
--   psql -v ON_ERROR_STOP=1 -f scripts/tests/push_variables_test.sql
-- 断言（门店键铁律写入校验）：
--   ① 合法 extra_filter（branch_number / (system_book_code,branch_num) 复合 / 其它维）INSERT 成功
--   ② 顶层裸 branch_num（{"branch_num":["1"]}）INSERT 报错
--   ③ 嵌套对象仅含 branch_num 单键 → 报错；嵌套 (system_book_code,branch_num) 复合 → 放行
--   ④ UPDATE 改成裸 branch_num 同样报错（trigger 覆盖 UPDATE）
--   ⑤ scope_dim 非法值 → CHECK 报错
--   ⑥ 种子存在：sale_amount（scope_dim=total）
-- 事务包裹，ROLLBACK 清理。

\set ON_ERROR_STOP on
BEGIN;

-- ① 合法 extra_filter INSERT 成功
INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('__t_pv_branch_number', 't-branch_number 键', 'sale_amount', 'branch', '{"branch_number":["3120-1","3120-2"]}'::jsonb, '元', true),
  ('__t_pv_composite', 't-复合门店键', 'sale_amount', 'branch', '{"system_book_code":["3120"],"branch_num":["1","2"]}'::jsonb, '元', true),
  ('__t_pv_other_dim', 't-非门店维', 'wholesale_amount', 'brand', '{"system_book_code":["64188"],"categories":["fruit"]}'::jsonb, '元', true),
  ('__t_pv_null_filter', 't-空过滤', 'sale_amount', 'total', NULL, '元', true);

-- ② 顶层裸 branch_num → trigger EXCEPTION
DO $$ DECLARE got_exc BOOLEAN := false; BEGIN
  BEGIN
    INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter)
    VALUES ('__t_pv_bare', 't-bare', 'sale_amount', 'branch', '{"branch_num":["1"]}'::jsonb);
  EXCEPTION WHEN OTHERS THEN got_exc := true; END;
  IF NOT got_exc THEN RAISE EXCEPTION 'assert2 failed: bare branch_num must be rejected'; END IF;
END $$;

-- ③a 嵌套对象仅含 branch_num 单键 → 报错
DO $$ DECLARE got_exc BOOLEAN := false; BEGIN
  BEGIN
    INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter)
    VALUES ('__t_pv_nested_bare', 't-nested-bare', 'sale_amount', 'branch', '{"scope":{"branch_num":["1"]}}'::jsonb);
  EXCEPTION WHEN OTHERS THEN got_exc := true; END;
  IF NOT got_exc THEN RAISE EXCEPTION 'assert3a failed: nested branch_num-only object must be rejected'; END IF;
END $$;

-- ③b 嵌套 (system_book_code,branch_num) 复合 → 放行
INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter)
VALUES ('__t_pv_nested_composite', 't-nested-composite', 'sale_amount', 'branch',
        '{"branch_filter":{"system_book_code":["3120"],"branch_num":["99"]}}'::jsonb);

-- ④ UPDATE 改成裸 branch_num → 报错（trigger 覆盖 UPDATE 路径）
DO $$ DECLARE got_exc BOOLEAN := false; BEGIN
  BEGIN
    UPDATE push_variables SET extra_filter = '{"branch_num":["1"]}'::jsonb
    WHERE var_code = '__t_pv_null_filter';
  EXCEPTION WHEN OTHERS THEN got_exc := true; END;
  IF NOT got_exc THEN RAISE EXCEPTION 'assert4 failed: UPDATE to bare branch_num must be rejected'; END IF;
END $$;

-- ⑤ scope_dim 非法值 → CHECK 报错
DO $$ DECLARE got_exc BOOLEAN := false; BEGIN
  BEGIN
    INSERT INTO push_variables (var_code, name, metric_code, scope_dim)
    VALUES ('__t_pv_bad_scope', 't-bad-scope', 'sale_amount', 'city');
  EXCEPTION WHEN OTHERS THEN got_exc := true; END;
  IF NOT got_exc THEN RAISE EXCEPTION 'assert5 failed: invalid scope_dim must be rejected'; END IF;
END $$;

-- ⑤b metric_code 外键：不存在的指标 → 报错
DO $$ DECLARE got_exc BOOLEAN := false; BEGIN
  BEGIN
    INSERT INTO push_variables (var_code, name, metric_code, scope_dim)
    VALUES ('__t_pv_bad_metric', 't-bad-metric', '__no_such_metric__', 'total');
  EXCEPTION WHEN OTHERS THEN got_exc := true; END;
  IF NOT got_exc THEN RAISE EXCEPTION 'assert5b failed: unknown metric_code must be rejected by FK'; END IF;
END $$;

-- ⑥ 种子存在且口径正确
DO $$ DECLARE n INT; BEGIN
  SELECT count(*) INTO n FROM push_variables WHERE var_code='sale_amount' AND scope_dim='total' AND metric_code='sale_amount';
  IF n <> 1 THEN RAISE EXCEPTION 'assert6 failed: seed sale_amount missing or wrong, n=%', n; END IF;
END $$;

ROLLBACK;

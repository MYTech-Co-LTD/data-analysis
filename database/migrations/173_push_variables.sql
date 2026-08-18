-- 173_push_variables.sql
-- U5a push_variables 白名单注册表（spec §5.1 / plan Task 7）。
-- 推送变量唯一来源：新可推指标 = INSERT 一行，不改引擎/生成器（语义层铁律）。
-- 门店键铁律写入校验：extra_filter 禁裸 branch_num，须 (system_book_code,branch_num) 复合或 branch_number。
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE OR REPLACE + DROP TRIGGER IF EXISTS + ON CONFLICT DO NOTHING。
-- 部署后需重启 postgrest 刷新 schema 缓存（C9 runbook）。

CREATE TABLE IF NOT EXISTS push_variables (
  var_code     TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  metric_code  TEXT REFERENCES metric_registry(metric_code),
  scope_dim    VARCHAR(20) NOT NULL CHECK (scope_dim IN ('total','brand','war_zone','region','branch')),
  extra_filter JSONB,
  unit         VARCHAR(20),
  enabled      BOOLEAN DEFAULT TRUE
);

-- ===== 门店键铁律写入校验 =====
-- 门店键 = (system_book_code, branch_num) 复合，或派生 branch_number（全局唯一）。
-- 禁止用 branch_num 单独做过滤（跨账套重复：3120/64188 各自从 1 编号，128 个 branch_num 两账套重号）。
CREATE OR REPLACE FUNCTION validate_push_extra_filter(f JSONB) RETURNS void AS $$
DECLARE
  k TEXT;
  v JSONB;
BEGIN
  IF f IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(f) <> 'object' THEN
    RAISE EXCEPTION 'extra_filter 必须是 JSON 对象，得到 %', jsonb_typeof(f)
      USING HINT = '门店键铁律：门店键 = (system_book_code,branch_num) 复合或 branch_number；禁裸 branch_num';
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(f) LOOP
    -- 顶层键 = branch_num 且无 system_book_code 配对 → 拒（裸门店键）；复合 (system_book_code,branch_num) 放行
    IF k = 'branch_num' AND NOT (f ? 'system_book_code') THEN
      RAISE EXCEPTION 'extra_filter 禁止顶层裸 branch_num（门店键铁律）'
        USING HINT = '门店键 = (system_book_code,branch_num) 复合，或派生 branch_number（全局唯一）；非门店维键放行';
    END IF;
    -- 值为对象且含 branch_num 但无 system_book_code 配对 → 拒（嵌套裸门店键）
    IF jsonb_typeof(v) = 'object' AND v ? 'branch_num' AND NOT (v ? 'system_book_code') THEN
      RAISE EXCEPTION 'extra_filter 嵌套对象含 branch_num 但缺 system_book_code 配对（门店键铁律）'
        USING HINT = '嵌套对象含 branch_num 必须同时含 system_book_code（复合键），或改用 branch_number';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- trigger 包装：BEFORE INSERT OR UPDATE 校验 NEW.extra_filter
CREATE OR REPLACE FUNCTION push_variables_check_extra_filter() RETURNS trigger AS $$
BEGIN
  PERFORM validate_push_extra_filter(NEW.extra_filter);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_push_variables_extra_filter ON push_variables;
CREATE TRIGGER trg_push_variables_extra_filter
  BEFORE INSERT OR UPDATE ON push_variables
  FOR EACH ROW EXECUTE FUNCTION push_variables_check_extra_filter();

-- ===== 注释钉死铁律 =====
COMMENT ON TABLE push_variables IS '推送变量白名单注册表（唯一来源）：新可推指标=INSERT一行，不改引擎。门店键铁律见 extra_filter 列注释';
COMMENT ON COLUMN push_variables.extra_filter IS '额外过滤条件 JSONB。门店键铁律：禁裸 branch_num（3120/64188 两账套重号）；门店过滤须 {system_book_code,branch_num} 复合或 branch_number，写入前 trigger 经 validate_push_extra_filter 强制校验';
COMMENT ON COLUMN push_variables.metric_code IS '关联 metric_registry.metric_code（口径单源，AST 复用）；达成率类变量待比率指标入 registry 后再种';

-- ===== 权限：读字典 =====
GRANT SELECT ON push_variables TO anon, authenticated;
GRANT EXECUTE ON FUNCTION validate_push_extra_filter(JSONB) TO anon, authenticated;

-- ===== 种子（核实 metric_registry 现有 9 指标后：sale_amount 存在；
--       achievement_rate 无对应比率指标（registry 仅 margin=毛利率），不虚种，缺口记 task-7 report）=====
INSERT INTO push_variables (var_code, name, metric_code, scope_dim, extra_filter, unit, enabled) VALUES
  ('sale_amount', '销售额', 'sale_amount', 'total', NULL, '元', true)
ON CONFLICT (var_code) DO NOTHING;

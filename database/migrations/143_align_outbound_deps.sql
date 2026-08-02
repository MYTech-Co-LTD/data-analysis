-- 143_align_outbound_deps.sql
-- 修正 outbound_amount/outbound_profit 的 depends_on 与 formula_ast 对齐
-- 旧 depends_on 列了 wholesale_pp/ext（formula_ast 不再引用，遗留死叶子）；
-- formula_ast 实际 = delivery_amount + wholesale_amount（branch 视图一直按此算，结果不变）。
-- 死叶子导致 item 视图 collectLeaves 拉非 item 表的 CTE，dim_grain join s.item_num 失败。
-- 对齐后 collectLeaves 只拉 AST 真实引用的 delivery/wholesale（item 视图可 source_override 到 item_outbound）。
-- 幂等：UPDATE 无副作用，重跑无碍。branch/region 视图 outbound 结果不变（AST 未变，仅去死叶子 CTE）。
UPDATE metric_registry SET depends_on = '["delivery_amount","wholesale_amount"]'::jsonb
  WHERE metric_code = 'outbound_amount';
UPDATE metric_registry SET depends_on = '["delivery_profit","wholesale_profit"]'::jsonb
  WHERE metric_code = 'outbound_profit';
DO $$ BEGIN RAISE NOTICE 'Migration 143: align outbound depends_on with formula_ast'; END $$;

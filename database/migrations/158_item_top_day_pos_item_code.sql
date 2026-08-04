-- 158_item_top_day_pos_item_code.sql
-- 修日榜 RPC get_item_top_by_day 归错：与月榜视图 report_item_breakdown_gen 口径对齐，
-- outbound 改用 pos_item_code（货来源编码）lateral join。
-- 原 141/145 用复合键 (sbc, item_num) JOIN dim_item，64188 批发（item_num 是 3120 货号）归错/丢：
--   - 64188 有同名 item_num 不同商品时归错（如 597：64188=云威月饼 83403，红宝石柚被归到云威月饼）
--   - 纯 3120 货号 dim_item(64188) 无则丢（实测 8-03 RPC outbound 259,489 < 底表 336,339，丢 76,850）
-- 修复：拆 sale（report_daily_item_sales 无 pos_item_code，用 item_num lateral，品牌内编号正确）
--   + outbound（report_daily_item_outbound 有 pos_item_code，用 pos_item_code lateral，货来源编码正确）
--   FULL OUTER JOIN 合并，COALESCE 跨侧。与月榜视图 cte0/cte1 结构一致。
-- 依赖：迁移 157（report_daily_item_outbound.pos_item_code 列）。
-- 幂等：DROP FUNCTION IF EXISTS + CREATE；GRANT 重跑无碍。部署后 restart postgrest。
DROP FUNCTION IF EXISTS get_item_top_by_day(BIGINT, DATE);
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(
  item_code TEXT, item_name TEXT, category_name TEXT,
  sale_amount NUMERIC, sale_profit NUMERIC,
  outbound_amount NUMERIC, outbound_profit NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  WITH sale AS (
    SELECT di.item_code,
      MAX(di.item_name) AS item_name, MAX(di.category_name) AS category_name,
      SUM(s.sale_amount) AS sale_amount,
      SUM(s.sale_profit) AS sale_profit
    FROM report_daily_item_sales s
    JOIN LATERAL (SELECT * FROM dim_item WHERE item_num = s.item_num ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
    WHERE s.biz_date = p_day
      AND EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id AND p_day BETWEEN t.start_date AND t.end_date)
    GROUP BY di.item_code
  ),
  outbound AS (
    SELECT di.item_code,
      MAX(di.item_name) AS item_name, MAX(di.category_name) AS category_name,
      SUM(s.delivery_amount) AS delivery_amount, SUM(s.wholesale_amount) AS wholesale_amount,
      SUM(s.delivery_profit) AS delivery_profit, SUM(s.wholesale_profit) AS wholesale_profit
    FROM report_daily_item_outbound s
    JOIN LATERAL (SELECT * FROM dim_item WHERE item_code = s.pos_item_code ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
    WHERE s.biz_date = p_day
      AND EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id AND p_day BETWEEN t.start_date AND t.end_date)
    GROUP BY di.item_code
  )
  SELECT COALESCE(s.item_code, o.item_code) AS item_code,
    COALESCE(s.item_name, o.item_name) AS item_name,
    COALESCE(s.category_name, o.category_name) AS category_name,
    COALESCE(s.sale_amount, 0) AS sale_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(s.sale_profit, 0) END AS sale_profit,
    COALESCE(o.delivery_amount, 0) + COALESCE(o.wholesale_amount, 0) AS outbound_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(o.delivery_profit, 0) + COALESCE(o.wholesale_profit, 0) END AS outbound_profit
  FROM sale s
  FULL OUTER JOIN outbound o ON o.item_code = s.item_code;
$$;
GRANT EXECUTE ON FUNCTION get_item_top_by_day(BIGINT, DATE) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 158: get_item_top_by_day outbound 改用 pos_item_code lateral（与月榜一致）'; END $$;

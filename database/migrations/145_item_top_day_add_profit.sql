-- 145_item_top_day_add_profit.sql
-- 商品日榜 RPC 加利润列（sale_profit / outbound_profit），成本脱敏对齐视图 report_item_breakdown_gen。
-- 服务：商品 TOP 日榜须展示销售毛利/出库毛利，RPC 原仅返 5 列（无利润）。
-- 脱敏：CASE WHEN current_setting('request.jwt.claims.can_see_cost', true)::boolean THEN ... END，无成本权限返 NULL。
-- SECURITY DEFINER 下 current_setting 仍读 session GUC（pgrst_pre_request 设的 GUC 是 session 级，SECURITY DEFINER 不改 session GUC）。
-- 幂等：CREATE OR REPLACE 不能改返回类型（OUT 参数变了），须先 DROP FUNCTION IF EXISTS 再 CREATE；GRANT 重跑无碍。
DROP FUNCTION IF EXISTS get_item_top_by_day(BIGINT, DATE);
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(
  item_code TEXT, item_name TEXT, category_name TEXT,
  sale_amount NUMERIC, sale_profit NUMERIC,
  outbound_amount NUMERIC, outbound_profit NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT di.item_code,
    MAX(di.item_name) AS item_name,
    MAX(di.category_name) AS category_name,
    COALESCE(SUM(x.sale_amount), 0) AS sale_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(SUM(x.sale_profit), 0) END AS sale_profit,
    COALESCE(SUM(x.delivery_amount), 0) + COALESCE(SUM(x.wholesale_amount), 0) AS outbound_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
         THEN COALESCE(SUM(x.delivery_profit), 0) + COALESCE(SUM(x.wholesale_profit), 0) END AS outbound_profit
  FROM (
    SELECT system_book_code, item_num,
           sale_amount, sale_profit,
           NULL::numeric AS delivery_amount, NULL::numeric AS wholesale_amount,
           NULL::numeric AS delivery_profit, NULL::numeric AS wholesale_profit
    FROM report_daily_item_sales WHERE biz_date = p_day
    UNION ALL
    SELECT system_book_code, item_num,
           NULL::numeric, NULL::numeric,
           delivery_amount, wholesale_amount,
           delivery_profit, wholesale_profit
    FROM report_daily_item_outbound WHERE biz_date = p_day
  ) x
  JOIN dim_item di ON di.system_book_code = x.system_book_code
                   AND di.item_num = x.item_num
                   AND di.item_code IS NOT NULL
  WHERE EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id
                  AND p_day BETWEEN t.start_date AND t.end_date)
  GROUP BY di.item_code;
$$;
GRANT EXECUTE ON FUNCTION get_item_top_by_day(BIGINT, DATE) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 145: get_item_top_by_day 加 sale_profit/outbound_profit（脱敏）'; END $$;

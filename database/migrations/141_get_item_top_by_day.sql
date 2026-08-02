-- 141_get_item_top_by_day.sql
-- 商品日榜 RPC：指定 target_id + 单日，按 item_code 合并全品牌销售+出库（join dim_item）
-- 服务：商品 TOP 日榜（销售/出库 × 选定日）。日榜选目标周期内截至当天任一天。
-- 粒度：item_code（跨品牌合并，dim_item join）。sale 来自 item_sales，outbound = delivery+wholesale 来自 item_outbound。
-- p_day 须在 target 周期内（否则返空）。
-- 幂等：CREATE OR REPLACE FUNCTION + ON CONFLICT 无关；GRANT 重跑无碍。
CREATE OR REPLACE FUNCTION get_item_top_by_day(p_target_id BIGINT, p_day DATE)
RETURNS TABLE(
  item_code TEXT, item_name TEXT, category_name TEXT,
  sale_amount NUMERIC, outbound_amount NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT di.item_code, MAX(di.item_name) AS item_name, MAX(di.category_name) AS category_name,
    COALESCE(SUM(x.sale_amount), 0) AS sale_amount,
    COALESCE(SUM(x.delivery_amount), 0) + COALESCE(SUM(x.wholesale_amount), 0) AS outbound_amount
  FROM (
    SELECT system_book_code, item_num, sale_amount,
           NULL::numeric AS delivery_amount, NULL::numeric AS wholesale_amount
    FROM report_daily_item_sales WHERE biz_date = p_day
    UNION ALL
    SELECT system_book_code, item_num, NULL::numeric, delivery_amount, wholesale_amount
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
DO $$ BEGIN RAISE NOTICE 'Migration 141: get_item_top_by_day RPC（商品日榜单日聚合）'; END $$;

-- 142_get_item_detail.sql
-- 商品弹层 RPC：指定 target_id + item_code，返回 日×品牌 的 sale + outbound 明细
-- 服务：ItemDetailDrawer（日趋势线 + 品牌分布 3120 vs 64188）
-- 锚 item_sales（sale 日），LEFT JOIN item_outbound 取 outbound（delivery+wholesale）
-- join dim_item 限定 p_item_code 对应的所有 item_num（跨品牌合并键）
-- 幂等：CREATE OR REPLACE FUNCTION；GRANT 重跑无碍。部署后 restart postgrest 刷 schema 缓存（新 RPC）。
CREATE OR REPLACE FUNCTION get_item_detail(p_target_id BIGINT, p_item_code TEXT)
RETURNS TABLE(
  biz_date DATE, system_book_code TEXT,
  sale_amount NUMERIC, outbound_amount NUMERIC
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT s.biz_date, s.system_book_code,
    COALESCE(SUM(s.sale_amount), 0) AS sale_amount,
    COALESCE(SUM(o.delivery_amount), 0) + COALESCE(SUM(o.wholesale_amount), 0) AS outbound_amount
  FROM targets t
  JOIN report_daily_item_sales s ON s.biz_date BETWEEN t.start_date AND t.end_date
  JOIN dim_item di ON di.system_book_code = s.system_book_code
                   AND di.item_num = s.item_num
                   AND di.item_code = p_item_code
  LEFT JOIN report_daily_item_outbound o ON o.biz_date = s.biz_date
                    AND o.system_book_code = s.system_book_code
                    AND o.item_num = s.item_num
  WHERE t.id = p_target_id
  GROUP BY s.biz_date, s.system_book_code
  ORDER BY s.biz_date;
$$;
GRANT EXECUTE ON FUNCTION get_item_detail(BIGINT, TEXT) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 142: get_item_detail RPC（商品弹层日×品牌明细）'; END $$;

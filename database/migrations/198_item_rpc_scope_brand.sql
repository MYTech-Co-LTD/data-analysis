-- 198_item_rpc_scope_brand.sql
-- 商品 TOP 日榜/弹层 RPC 权限漏洞修复（2026-08-18 审计发现）：
--   get_item_top_by_day / get_item_detail 是 SECURITY DEFINER + owner=postgres + GRANT PUBLIC，
--   以 postgres 身份执行绕过基表 report_rls_brand（品牌粒度表行级策略）——brands=[]（如仅授权
--   门店范围东部战区）的用户经报表中心「商品 TOP」日榜/弹层读到全品牌商品金额（实测 1485 行、
--   含 64188 品品甜），与月榜视图（基表 RLS 生效=deny）行为不一致。
-- 修复（用户确认方案 A：函数体加品牌过滤）：
--   ① 两个 RPC 的 fact 查询加 scope_match_v2('brands', system_book_code)——对齐月榜视图口径，
--      brands=[] → deny，brands=['3120'] → 只 3120，brands=['*'] → 全放。
--   ② get_item_top_by_day 成本读法改 can_cost_visible()（197 后标准：读 request.jwt.claims.fields.cost）；
--      旧 current_setting('request.jwt.claims.can_see_cost') 是 197 已废弃的顶层 key，恒读 false 误掩成本。
-- 语义：品牌粒度数据授权单位是「品牌」非「门店」（item_sales/item_outbound 无门店列，RLS 只有
--      brands 维）。函数仍是 SECURITY DEFINER（保留 targets 可见性设计——门店用户能看到 ALL 目标，
--      见 web/lib/report-center/boards/item-top/manifest.ts 注释），但品牌维不绕过。
-- 幂等：DROP FUNCTION IF EXISTS + CREATE OR REPLACE（158 已先 DROP 改签名，此版签名不变仍按先例）。
-- GRANT 重跑无碍。部署后 restart postgrest 刷 schema 缓存（改函数体）。
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
      AND scope_match_v2('brands', s.system_book_code)
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
      AND scope_match_v2('brands', s.system_book_code)
      AND EXISTS (SELECT 1 FROM targets t WHERE t.id = p_target_id AND p_day BETWEEN t.start_date AND t.end_date)
    GROUP BY di.item_code
  )
  SELECT COALESCE(s.item_code, o.item_code) AS item_code,
    COALESCE(s.item_name, o.item_name) AS item_name,
    COALESCE(s.category_name, o.category_name) AS category_name,
    COALESCE(s.sale_amount, 0) AS sale_amount,
    CASE WHEN can_cost_visible()
         THEN COALESCE(s.sale_profit, 0) END AS sale_profit,
    COALESCE(o.delivery_amount, 0) + COALESCE(o.wholesale_amount, 0) AS outbound_amount,
    CASE WHEN can_cost_visible()
         THEN COALESCE(o.delivery_profit, 0) + COALESCE(o.wholesale_profit, 0) END AS outbound_profit
  FROM sale s
  FULL OUTER JOIN outbound o ON o.item_code = s.item_code;
$$;
GRANT EXECUTE ON FUNCTION get_item_top_by_day(BIGINT, DATE) TO anon, authenticated;
DO $$ BEGIN RAISE NOTICE 'Migration 198: get_item_top_by_day 加品牌过滤 scope_match_v2 + 成本读法 can_cost_visible'; END $$;

-- get_item_detail：商品弹层（日×品牌明细），同样 SECURITY DEFINER 绕过 report_rls_brand → 加品牌过滤。
-- 无利润列（仅 sale_amount/outbound_amount），只需品牌维过滤，无成本掩码问题。
DROP FUNCTION IF EXISTS get_item_detail(BIGINT, TEXT);
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
    AND scope_match_v2('brands', s.system_book_code)
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
DO $$ BEGIN RAISE NOTICE 'Migration 198: get_item_detail 加品牌过滤 scope_match_v2'; END $$;

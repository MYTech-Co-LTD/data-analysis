DROP VIEW IF EXISTS report_item_breakdown_gen;
CREATE VIEW report_item_breakdown_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active', 'closed')
),
cte0 AS (
  SELECT tgt.target_id, di.item_code,
    SUM(s.sale_amount) AS sale_amount,
    SUM(s.sale_profit) AS sale_profit,
    MAX(di.item_name) AS item_name,
    MAX(di.category_name) AS category_name,
    MAX(di.top_category) AS top_category,
    MAX(di.item_brand) AS item_brand,
    MAX(di.category_group) AS category_group
  FROM report_daily_item_sales s
  JOIN LATERAL (SELECT * FROM dim_item WHERE item_num = s.item_num ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code)
  GROUP BY tgt.target_id, di.item_code
),
cte1 AS (
  SELECT tgt.target_id, di.item_code,
    SUM(s.delivery_amount) AS delivery_amount,
    SUM(s.delivery_profit) AS delivery_profit,
    SUM(s.wholesale_amount) AS wholesale_amount,
    SUM(s.wholesale_profit) AS wholesale_profit,
    MAX(di.item_name) AS item_name,
    MAX(di.category_name) AS category_name,
    MAX(di.top_category) AS top_category,
    MAX(di.item_brand) AS item_brand,
    MAX(di.category_group) AS category_group
  FROM report_daily_item_outbound s
  JOIN LATERAL (SELECT * FROM dim_item WHERE item_num = s.item_num ORDER BY (system_book_code = s.system_book_code) DESC LIMIT 1) di ON true
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code)
  GROUP BY tgt.target_id, di.item_code
)
SELECT COALESCE(cte0.target_id, cte1.target_id) AS target_id,
  COALESCE(cte0.item_code, cte1.item_code) AS item_code,
  COALESCE(cte0.item_name, cte1.item_name) AS item_name,
  COALESCE(cte0.category_name, cte1.category_name) AS category_name,
  COALESCE(cte0.top_category, cte1.top_category) AS top_category,
  COALESCE(cte0.item_brand, cte1.item_brand) AS item_brand,
  COALESCE(cte0.category_group, cte1.category_group) AS category_group,
  cte0.sale_amount AS sale_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN cte0.sale_profit END AS sale_profit,
  cte1.delivery_amount AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN cte1.delivery_profit END AS delivery_profit,
  cte1.wholesale_amount AS wholesale_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN cte1.wholesale_profit END AS wholesale_profit,
  COALESCE((COALESCE(cte1.delivery_amount, 0) + COALESCE(cte1.wholesale_amount, 0)), 0) AS outbound_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE((COALESCE(cte1.delivery_profit, 0) + COALESCE(cte1.wholesale_profit, 0)), 0) END AS outbound_profit
FROM cte0
FULL OUTER JOIN cte1 ON cte1.target_id = cte0.target_id AND cte1.item_code = cte0.item_code;

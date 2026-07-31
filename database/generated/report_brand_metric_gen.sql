DROP VIEW IF EXISTS report_brand_metric_gen;
CREATE VIEW report_brand_metric_gen AS
WITH cte0 AS (
  SELECT system_book_code,
    SUM(total_sale) AS sale_amount
  FROM report_daily_sales
  GROUP BY system_book_code
),
cte1 AS (
  SELECT system_book_code,
    SUM(out_money) AS delivery_amount,
    SUM(profit_money) AS delivery_profit
  FROM report_daily_delivery
  GROUP BY system_book_code
),
cte2 AS (
  SELECT system_book_code,
    SUM(wholesale_amount) AS wholesale_pp_amount,
    SUM(wholesale_profit) AS wholesale_pp_profit
  FROM report_daily_wholesale_customer
  WHERE system_book_code = '64188'
  GROUP BY system_book_code
)
SELECT COALESCE(cte0.system_book_code, cte1.system_book_code, cte2.system_book_code) AS brand_code,
  cte0.sale_amount AS sale_amount,
  COALESCE(cte1.delivery_amount, 0) + COALESCE(cte2.wholesale_pp_amount, 0) AS distribution_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(cte1.delivery_profit, 0) + COALESCE(cte2.wholesale_pp_profit, 0) END AS distribution_profit,
  COALESCE((COALESCE(cte1.delivery_amount, 0) + COALESCE(cte2.wholesale_pp_amount, 0)), 0) / NULLIF(COALESCE((cte0.sale_amount), 0), 0) AS delivery_sale_ratio
FROM cte0
FULL OUTER JOIN cte1 ON cte1.system_book_code = cte0.system_book_code
FULL OUTER JOIN cte2 ON cte2.system_book_code = cte0.system_book_code

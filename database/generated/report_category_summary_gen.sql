DROP VIEW IF EXISTS report_category_summary_gen;
CREATE VIEW report_category_summary_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
),
union0 AS (
  SELECT tgt.target_id, s.category_group,
    SUM(s.out_money) AS delivery_amount,
    SUM(s.profit_money) AS delivery_profit
  FROM report_daily_delivery s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, s.category_group
),
union1 AS (
  SELECT tgt.target_id, s.category_group,
    SUM(s.wholesale_money) AS wholesale_amount,
    SUM(s.wholesale_profit) AS wholesale_profit
  FROM report_daily_wholesale s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, s.category_group
),
cte2 AS (
  SELECT union0.target_id, union0.category_group, union0.delivery_amount, union0.delivery_profit, union1.wholesale_amount, union1.wholesale_profit
  FROM union0
  FULL OUTER JOIN union1 ON union1.target_id = union0.target_id AND union1.category_group = union0.category_group
)
, brand_rows AS (
SELECT cte2.target_id,
  cte2.category_group AS category_group,
  COALESCE((COALESCE(cte2.delivery_amount, 0) + COALESCE(cte2.wholesale_amount, 0)), 0) AS outbound_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE((COALESCE(cte2.delivery_profit, 0) + COALESCE(cte2.wholesale_profit, 0)), 0) END AS outbound_profit
FROM cte2
)
SELECT * FROM brand_rows
UNION ALL
SELECT tgt.target_id, '合计' AS category_group, SUM(brand_rows.outbound_amount) AS outbound_amount, CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN SUM(brand_rows.outbound_profit) END AS outbound_profit
FROM brand_rows JOIN tgt ON tgt.target_id = brand_rows.target_id
GROUP BY tgt.target_id;

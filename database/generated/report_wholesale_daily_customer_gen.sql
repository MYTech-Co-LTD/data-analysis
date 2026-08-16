DROP VIEW IF EXISTS report_wholesale_daily_customer_gen CASCADE;
CREATE VIEW report_wholesale_daily_customer_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active')
),
cte0 AS (
  SELECT tgt.target_id, s.client_code, s.biz_date,
    SUM(s.wholesale_amount) AS wholesale_ext_customer_amount,
    SUM(s.wholesale_profit) AS wholesale_ext_customer_profit,
    MAX(s.client_name) AS client_name
  FROM report_daily_wholesale_customer s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.latest_day
  WHERE s.system_book_code = '3120' AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text)
  GROUP BY tgt.target_id, s.client_code, s.biz_date
)
SELECT cte0.target_id AS target_id,
  cte0.client_code AS client_code,
  cte0.biz_date AS biz_date,
  cte0.client_name AS client_name,
  cte0.wholesale_ext_customer_amount AS wholesale_ext_customer_amount,
  CASE WHEN can_cost_visible() THEN cte0.wholesale_ext_customer_profit END AS wholesale_ext_customer_profit,
  CASE WHEN can_cost_visible() THEN round((COALESCE(cte0.wholesale_ext_customer_profit, 0) / NULLIF(COALESCE(cte0.wholesale_ext_customer_amount, 0), 0)), 4) END AS wholesale_ext_customer_margin
FROM cte0;

DROP VIEW IF EXISTS report_wholesale_customer_gen CASCADE;
CREATE VIEW report_wholesale_customer_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active', 'closed')
),
cte0 AS (
  SELECT tgt.target_id, s.client_code,
    SUM(s.wholesale_amount) AS wholesale_amount,
    SUM(s.wholesale_profit) AS wholesale_profit,
    MAX(s.client_name) AS client_name,
    MAX(s.system_book_code) AS system_book_code
  FROM report_daily_wholesale_customer s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text)
  GROUP BY tgt.target_id, s.client_code
)
SELECT cte0.target_id AS target_id,
  cte0.client_code AS client_code,
  cte0.client_name AS client_name,
  cte0.system_book_code AS system_book_code,
  cte0.wholesale_amount AS wholesale_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN cte0.wholesale_profit END AS wholesale_profit,
  (SELECT db.system_book_code FROM dim_branch db WHERE db.branch_name = cte0.client_name LIMIT 1) AS client_brand_code
FROM cte0;

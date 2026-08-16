DROP VIEW IF EXISTS report_wholesale_daily_gen CASCADE;
CREATE VIEW report_wholesale_daily_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active')
),
cte0 AS (
  SELECT tgt.target_id, s.biz_date,
    SUM(s.wholesale_money) AS wholesale_ext_amount,
    SUM(s.wholesale_profit) AS wholesale_ext_profit
  FROM report_daily_wholesale s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.latest_day
  WHERE s.system_book_code = '3120' AND scope_match_v2('brands', s.system_book_code) AND (scope_match_v2('branch_nums', s.branch_num::text) OR scope_match_v2('branch_nums', s.system_book_code || '-' || s.branch_num))
  GROUP BY tgt.target_id, s.biz_date
)
SELECT cte0.target_id AS target_id,
  cte0.biz_date AS biz_date,
  cte0.wholesale_ext_amount AS wholesale_ext_amount,
  CASE WHEN can_cost_visible() THEN cte0.wholesale_ext_profit END AS wholesale_ext_profit,
  CASE WHEN can_cost_visible() THEN round((COALESCE(cte0.wholesale_ext_profit, 0) / NULLIF(COALESCE(cte0.wholesale_ext_amount, 0), 0)), 4) END AS wholesale_ext_margin
FROM cte0;

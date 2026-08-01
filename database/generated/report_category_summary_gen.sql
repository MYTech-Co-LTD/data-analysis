DROP VIEW IF EXISTS report_category_summary_gen;
CREATE VIEW report_category_summary_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
),
delivery_actuals AS (
  SELECT tgt.target_id, s.category_group,
    SUM(s.out_money) AS sale_actual,
    SUM(s.profit_money) AS profit_actual,
    SUM(s.out_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_sale,
    SUM(s.profit_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_profit
  FROM report_daily_delivery s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  WHERE s.category_group IN ('水果', '标品', '耗材')
  GROUP BY tgt.target_id, s.category_group
),
wholesale_actuals AS (
  SELECT tgt.target_id, s.category_group,
    SUM(s.wholesale_money) AS sale_actual,
    SUM(s.wholesale_profit) AS profit_actual,
    SUM(s.wholesale_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_sale,
    SUM(s.wholesale_profit) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_profit
  FROM report_daily_wholesale s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  WHERE s.category_group IN ('水果', '标品', '耗材')
  GROUP BY tgt.target_id, s.category_group
),
merged_actuals AS (
  SELECT COALESCE(d.target_id, w.target_id) AS target_id,
    COALESCE(d.category_group, w.category_group) AS category_group,
    COALESCE(d.sale_actual, 0) + COALESCE(w.sale_actual, 0) AS sale_actual,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(d.profit_actual, 0) + COALESCE(w.profit_actual, 0) END AS profit_actual,
    COALESCE(d.daily_sale, 0) + COALESCE(w.daily_sale, 0) AS daily_sale,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(d.daily_profit, 0) + COALESCE(w.daily_profit, 0) END AS daily_profit
  FROM delivery_actuals d
  FULL OUTER JOIN wholesale_actuals w ON w.target_id = d.target_id AND w.category_group = d.category_group
),
category_level AS (
  SELECT tgt.target_id,
    c.category AS category_group,
    COALESCE(ma.sale_actual, 0) AS sale_actual,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(ma.profit_actual, 0) END AS profit_actual,
    COALESCE(ma.daily_sale, 0) AS daily_sale,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(ma.daily_profit, 0) END AS daily_profit,
    tgt.total_days,
    tgt.days_elapsed
  FROM tgt
  CROSS JOIN (VALUES ('水果'), ('标品'), ('耗材')) AS c(category)
  LEFT JOIN merged_actuals ma ON ma.target_id = tgt.target_id AND ma.category_group = c.category
  
),
total_level AS (
  SELECT target_id,
    '合计' AS category_group,
    MAX(total_days) AS total_days,
    MAX(days_elapsed) AS days_elapsed
  FROM category_level
  GROUP BY target_id
)
SELECT target_id, category_group FROM category_level
UNION ALL
SELECT target_id, category_group FROM total_level;

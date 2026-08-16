DROP VIEW IF EXISTS report_category_summary_gen CASCADE;
CREATE VIEW report_category_summary_gen AS
WITH target_base AS (
  SELECT
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status IN ('active') AND t.target_level = 'total' AND t.category IS NULL
),
outbound_targets AS (
  SELECT
    t.parent_target_id AS target_id,
    t.category,
    MAX(tmv.target_value) FILTER (WHERE metric_code='outbound_amt') AS sale_target,
    MAX(tmv.target_value) FILTER (WHERE metric_code='outbound_profit') AS profit_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id
  WHERE t.target_type = 'hq' AND t.parent_target_id IS NOT NULL AND t.category IS NOT NULL
  GROUP BY t.parent_target_id, t.category
),
delivery_actuals AS (
  SELECT
    tb.target_id,
    d.category_group AS category,
    SUM(d.out_money) AS sale_actual,
    SUM(d.profit_money) AS profit_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.out_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.profit_money ELSE 0 END) AS daily_profit
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR d.system_book_code = tb.system_book_code)
    AND d.category_group IN ('水果', '标品', '耗材')
    AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, d.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, d.branch_num::text)
  GROUP BY tb.target_id, d.category_group
),
wholesale_actuals AS (
  SELECT
    tb.target_id,
    w.category_group AS category,
    SUM(w.wholesale_money) AS sale_actual,
    SUM(w.wholesale_profit) AS profit_actual,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_profit ELSE 0 END) AS daily_profit
  FROM report_daily_wholesale w
  JOIN target_base tb ON w.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR w.system_book_code = tb.system_book_code)
    AND w.category_group IN ('水果', '标品', '耗材')
    AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, w.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, w.branch_num::text)
  GROUP BY tb.target_id, w.category_group
),
category_actuals AS (
  SELECT
    COALESCE(d.target_id, w.target_id) AS target_id,
    COALESCE(d.category, w.category) AS category,
    COALESCE(d.sale_actual, 0) + COALESCE(w.sale_actual, 0) AS sale_actual,
    CASE WHEN can_cost_visible() THEN COALESCE(d.profit_actual, 0) + COALESCE(w.profit_actual, 0) END AS profit_actual,
    COALESCE(d.daily_amount, 0) + COALESCE(w.daily_amount, 0) AS daily_amount,
    CASE WHEN can_cost_visible() THEN COALESCE(d.daily_profit, 0) + COALESCE(w.daily_profit, 0) END AS daily_profit
  FROM delivery_actuals d
  FULL OUTER JOIN wholesale_actuals w ON w.target_id = d.target_id AND w.category = d.category
),
category_level AS (
  SELECT
    tb.target_id,
    cats.category,
    ot.sale_target,
    ca.sale_actual,
    CASE WHEN ot.sale_target > 0 THEN ROUND(ca.sale_actual / ot.sale_target, 4) ELSE NULL END AS sale_rate,
    ot.profit_target,
    ca.profit_actual,
    CASE WHEN ot.profit_target > 0 THEN ROUND(ca.profit_actual / ot.profit_target, 4) ELSE NULL END AS profit_rate,
    CASE WHEN ca.sale_actual > 0 THEN ROUND(ca.profit_actual / ca.sale_actual, 4) ELSE NULL END AS profit_margin,
    ca.daily_amount,
    ca.daily_profit,
    CASE WHEN ca.daily_amount > 0 THEN ROUND(ca.daily_profit / ca.daily_amount, 4) ELSE NULL END AS daily_profit_margin,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND ot.profit_target > 0
      THEN ROUND((ot.profit_target - COALESCE(ca.profit_actual, 0)) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_profit_target
  FROM target_base tb
  CROSS JOIN (VALUES ('水果'), ('标品'), ('耗材')) AS cats(category)
  LEFT JOIN outbound_targets ot ON ot.target_id = tb.target_id AND ot.category = cats.category
  LEFT JOIN category_actuals ca ON ca.target_id = tb.target_id AND ca.category = cats.category
),
total_level AS (
  SELECT
    target_id,
    '合计' AS category,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(profit_target) AS profit_target,
    SUM(profit_actual) AS profit_actual,
    CASE WHEN SUM(profit_target) > 0 THEN ROUND(SUM(profit_actual) / SUM(profit_target), 4) ELSE NULL END AS profit_rate,
    CASE WHEN SUM(sale_actual) > 0 THEN ROUND(SUM(profit_actual) / SUM(sale_actual), 4) ELSE NULL END AS profit_margin,
    SUM(daily_amount) AS daily_amount,
    SUM(daily_profit) AS daily_profit,
    CASE WHEN SUM(daily_amount) > 0 THEN ROUND(SUM(daily_profit) / SUM(daily_amount), 4) ELSE NULL END AS daily_profit_margin,
    SUM(remaining_daily_profit_target) AS remaining_daily_profit_target
  FROM category_level
  GROUP BY target_id
)
SELECT target_id, category, sale_target, sale_actual, sale_rate, profit_target, profit_actual, profit_rate, profit_margin, daily_amount, daily_profit, daily_profit_margin, remaining_daily_profit_target FROM category_level
UNION ALL
SELECT target_id, category, sale_target, sale_actual, sale_rate, profit_target, profit_actual, profit_rate, profit_margin, daily_amount, daily_profit, daily_profit_margin, remaining_daily_profit_target FROM total_level;

DROP VIEW IF EXISTS report_brand_metric_gen CASCADE;
CREATE VIEW report_brand_metric_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active')
),
cte0 AS (
  SELECT tgt.target_id, s.system_book_code,
    SUM(s.total_sale) AS sale_amount
  FROM report_daily_sales s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text) AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code
),
cte1 AS (
  SELECT tgt.target_id, s.system_book_code,
    SUM(s.out_money) AS delivery_amount,
    SUM(s.profit_money) AS delivery_profit
  FROM report_daily_delivery s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text) AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code
),
cte2 AS (
  SELECT tgt.target_id, s.system_book_code,
    SUM(s.wholesale_amount) AS wholesale_pp_amount,
    SUM(s.wholesale_profit) AS wholesale_pp_profit
  FROM report_daily_wholesale_customer s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE s.system_book_code = '64188' AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text) AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code
),
cte3 AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code,
    SUM(tmv.target_value) AS sale_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id
  WHERE t.breakdown_level='store' AND metric_code='sale' AND (t.branch_num = 'ALL' OR claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, t.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, t.branch_num::text)) AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code=t.system_book_code AND db.branch_num=t.branch_num AND is_assessed_war_zone(db.first_level_region))
  GROUP BY t.parent_target_id, t.system_book_code
)
, brand_rows AS (
SELECT tgt.target_id,
  b.system_book_code AS system_book_code,
  b.brand_name,
  cte0.sale_amount AS sale_amount,
  cte3.sale_target AS sale_target,
  round((COALESCE(cte0.sale_amount, 0) / NULLIF(COALESCE(cte3.sale_target, 0), 0)), 4) AS sale_rate,
  COALESCE((COALESCE(cte1.delivery_amount, 0) + COALESCE(cte2.wholesale_pp_amount, 0)), 0) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE((COALESCE(cte1.delivery_profit, 0) + COALESCE(cte2.wholesale_pp_profit, 0)), 0) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((((COALESCE(cte1.delivery_profit, 0) + COALESCE(cte2.wholesale_pp_profit, 0))) / NULLIF(((COALESCE(cte1.delivery_amount, 0) + COALESCE(cte2.wholesale_pp_amount, 0))), 0)), 4) END AS delivery_margin
FROM dim_brand b
CROSS JOIN tgt
LEFT JOIN cte0 ON cte0.target_id = tgt.target_id AND cte0.system_book_code = b.system_book_code
LEFT JOIN cte1 ON cte1.target_id = tgt.target_id AND cte1.system_book_code = b.system_book_code
LEFT JOIN cte2 ON cte2.target_id = tgt.target_id AND cte2.system_book_code = b.system_book_code
LEFT JOIN cte3 ON cte3.target_id = tgt.target_id AND cte3.system_book_code = b.system_book_code
)
SELECT * FROM brand_rows
UNION ALL
SELECT tgt.target_id, '合计' AS system_book_code, NULL AS brand_name, SUM(brand_rows.sale_amount) AS sale_amount, SUM(brand_rows.sale_target) AS sale_target, round(COALESCE(SUM(brand_rows.sale_amount), 0) / NULLIF(COALESCE(SUM(brand_rows.sale_target), 0), 0), 4) AS sale_rate, SUM(brand_rows.delivery_amount) AS delivery_amount, CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN SUM(brand_rows.delivery_profit) END AS delivery_profit, CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round(COALESCE(SUM(brand_rows.delivery_profit), 0) / NULLIF(COALESCE(SUM(brand_rows.delivery_amount), 0), 0), 4) END AS delivery_margin
FROM brand_rows JOIN tgt ON tgt.target_id = brand_rows.target_id
GROUP BY tgt.target_id;

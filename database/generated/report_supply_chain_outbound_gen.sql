DROP VIEW IF EXISTS report_supply_chain_outbound_gen CASCADE;
CREATE VIEW report_supply_chain_outbound_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status IN ('active')
),
leaf_act_0 AS (
  SELECT tgt.target_id, s.system_book_code, s.branch_num,
    SUM(s.out_money) AS delivery_amount,
    SUM(s.profit_money) AS delivery_profit,
    SUM(s.out_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_delivery_amount,
    SUM(s.profit_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_delivery_profit
  FROM report_daily_delivery s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, s.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, s.branch_num::text) AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code, s.branch_num
),
leaf_rows AS (
  SELECT tgt.target_id,
  'store' AS level,
  db.system_book_code AS system_book_code,
  db.branch_num AS branch_num,
  db.first_level_region AS region_code,
  db.first_level_region AS region_name,
  db.second_level_region AS sub_region_code,
  db.second_level_region AS sub_region_name,
  db.branch_name AS branch_name,
  db.first_level_region AS war_zone,
  db.second_level_region AS region_l2,
  COALESCE(a0.delivery_amount, 0) AS delivery_amount,
  COALESCE(a0.delivery_profit, 0) AS delivery_profit,
  COALESCE(a0.daily_delivery_amount, 0) AS daily_delivery_amount,
  COALESCE(a0.daily_delivery_profit, 0) AS daily_delivery_profit,
  tgt.total_days,
  tgt.days_elapsed
  FROM tgt CROSS JOIN dim_branch db
  LEFT JOIN leaf_act_0 a0 ON a0.target_id = tgt.target_id AND a0.system_book_code = db.system_book_code AND a0.branch_num = db.branch_num
  WHERE db.is_active AND db.branch_num <> '99' AND claim_match_or_star(current_setting('request.jwt.claims.brands', true)::jsonb, db.system_book_code) AND claim_match_or_star(current_setting('request.jwt.claims.branch_nums', true)::jsonb, db.branch_num::text) AND is_assessed_war_zone(db.first_level_region)
),
region_act AS (
  SELECT target_id, war_zone,
    SUM(delivery_amount) AS delivery_amount,
    SUM(delivery_profit) AS delivery_profit,
    SUM(daily_delivery_amount) AS daily_delivery_amount,
    SUM(daily_delivery_profit) AS daily_delivery_profit,
    MAX(total_days) AS total_days,
    MAX(days_elapsed) AS days_elapsed
  FROM leaf_rows
  GROUP BY target_id, war_zone
),
sub_region_act AS (
  SELECT target_id, war_zone, region_l2,
    SUM(delivery_amount) AS delivery_amount,
    SUM(delivery_profit) AS delivery_profit,
    SUM(daily_delivery_amount) AS daily_delivery_amount,
    SUM(daily_delivery_profit) AS daily_delivery_profit,
    MAX(total_days) AS total_days,
    MAX(days_elapsed) AS days_elapsed
  FROM leaf_rows
  GROUP BY target_id, war_zone, region_l2
)
SELECT
  a.target_id,
  'region' AS level,
  NULL::text AS parent_code,
  a.war_zone AS region_code,
  a.war_zone AS region_name,
  NULL::text AS sub_region_code,
  NULL::text AS sub_region_name,
  NULL::text AS branch_num,
  NULL::text AS branch_name,
  NULL::text AS war_zone,
  NULL::text AS region_l2,
  COALESCE(a.delivery_amount, 0) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.delivery_profit, 0) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.delivery_profit, 0) / NULLIF(COALESCE(a.delivery_amount, 0), 0)), 4) END AS delivery_margin,
  COALESCE(a.daily_delivery_amount, 0) AS daily_delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.daily_delivery_profit, 0) END AS daily_delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.daily_delivery_profit, 0) / NULLIF(COALESCE(a.daily_delivery_amount, 0), 0)), 4) END AS daily_delivery_margin
FROM region_act a
UNION ALL
SELECT
  a.target_id,
  'sub_region' AS level,
  a.war_zone AS parent_code,
  a.war_zone AS region_code,
  a.war_zone AS region_name,
  a.region_l2 AS sub_region_code,
  a.region_l2 AS sub_region_name,
  NULL::text AS branch_num,
  NULL::text AS branch_name,
  NULL::text AS war_zone,
  NULL::text AS region_l2,
  COALESCE(a.delivery_amount, 0) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.delivery_profit, 0) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.delivery_profit, 0) / NULLIF(COALESCE(a.delivery_amount, 0), 0)), 4) END AS delivery_margin,
  COALESCE(a.daily_delivery_amount, 0) AS daily_delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.daily_delivery_profit, 0) END AS daily_delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.daily_delivery_profit, 0) / NULLIF(COALESCE(a.daily_delivery_amount, 0), 0)), 4) END AS daily_delivery_margin
FROM sub_region_act a
UNION ALL
SELECT
  a.target_id,
  'store' AS level,
  a.region_l2 AS parent_code,
  a.region_code AS region_code,
  a.region_name AS region_name,
  a.sub_region_code AS sub_region_code,
  a.sub_region_name AS sub_region_name,
  a.branch_num AS branch_num,
  a.branch_name AS branch_name,
  a.war_zone AS war_zone,
  a.region_l2 AS region_l2,
  COALESCE(a.delivery_amount, 0) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.delivery_profit, 0) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.delivery_profit, 0) / NULLIF(COALESCE(a.delivery_amount, 0), 0)), 4) END AS delivery_margin,
  COALESCE(a.daily_delivery_amount, 0) AS daily_delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(a.daily_delivery_profit, 0) END AS daily_delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN round((COALESCE(a.daily_delivery_profit, 0) / NULLIF(COALESCE(a.daily_delivery_amount, 0), 0)), 4) END AS daily_delivery_margin
FROM leaf_rows a;

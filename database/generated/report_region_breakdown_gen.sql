DROP VIEW IF EXISTS report_region_breakdown_gen;
CREATE VIEW report_region_breakdown_gen AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
),
leaf_act_0 AS (
  SELECT tgt.target_id, s.system_book_code, s.branch_num,
    SUM(s.total_sale) AS sale_amount,
    SUM(s.total_sale) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_sale
  FROM report_daily_sales s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code, s.branch_num
),
leaf_act_1 AS (
  SELECT tgt.target_id, s.system_book_code, s.branch_num,
    SUM(s.out_money) AS delivery_amount,
    SUM(s.out_money) FILTER (WHERE s.biz_date = tgt.latest_day) AS daily_delivery
  FROM report_daily_delivery s
  JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, s.system_book_code, s.branch_num
),
leaf_tgt AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code, t.branch_num,
    MAX(tmv.target_value) FILTER (WHERE metric_code='sale') AS sale_target,
    MAX(tmv.target_value) FILTER (WHERE metric_code='delivery') AS delivery_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (metric_code='sale' OR metric_code='delivery')
  JOIN dim_branch db ON db.system_book_code = t.system_book_code AND db.branch_num = t.branch_num
  WHERE t.breakdown_level = 'store' AND t.branch_num <> 'ALL' AND is_assessed_war_zone(db.first_level_region)
  GROUP BY t.parent_target_id, t.system_book_code, t.branch_num
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
  COALESCE(a0.sale_amount, 0) AS sale_amount,
  COALESCE(a0.daily_sale, 0) AS daily_sale,
  COALESCE(a1.delivery_amount, 0) AS delivery_amount,
  COALESCE(a1.daily_delivery, 0) AS daily_delivery,
  COALESCE(a2.sale_target, 0) AS sale_target,
  COALESCE(a2.delivery_target, 0) AS delivery_target,
  tgt.total_days,
  tgt.days_elapsed
  FROM tgt CROSS JOIN dim_branch db
  LEFT JOIN leaf_act_0 a0 ON a0.target_id = tgt.target_id AND a0.system_book_code = db.system_book_code AND a0.branch_num = db.branch_num
  LEFT JOIN leaf_act_1 a1 ON a1.target_id = tgt.target_id AND a1.system_book_code = db.system_book_code AND a1.branch_num = db.branch_num
  LEFT JOIN leaf_tgt a2 ON a2.target_id = tgt.target_id AND a2.system_book_code = db.system_book_code AND a2.branch_num = db.branch_num
  WHERE db.is_active AND db.branch_num <> '99' AND is_assessed_war_zone(db.first_level_region)
),
region_act AS (
  SELECT target_id, war_zone,
    SUM(sale_amount) AS sale_amount,
    SUM(daily_sale) AS daily_sale,
    SUM(delivery_amount) AS delivery_amount,
    SUM(daily_delivery) AS daily_delivery,
    MAX(total_days) AS total_days,
    MAX(days_elapsed) AS days_elapsed
  FROM leaf_rows
  GROUP BY target_id, war_zone
),
region_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone,
    MAX(tmv.target_value) FILTER (WHERE metric_code='sale') AS sale_target,
    MAX(tmv.target_value) FILTER (WHERE metric_code='delivery') AS delivery_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (metric_code='sale' OR metric_code='delivery')
  WHERE t.breakdown_level = 'war_zone' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone
),
sub_region_act AS (
  SELECT target_id, war_zone, region_l2,
    SUM(sale_amount) AS sale_amount,
    SUM(daily_sale) AS daily_sale,
    SUM(delivery_amount) AS delivery_amount,
    SUM(daily_delivery) AS daily_delivery,
    MAX(total_days) AS total_days,
    MAX(days_elapsed) AS days_elapsed
  FROM leaf_rows
  GROUP BY target_id, war_zone, region_l2
),
sub_region_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone, t.region_l2,
    MAX(tmv.target_value) FILTER (WHERE metric_code='sale') AS sale_target,
    MAX(tmv.target_value) FILTER (WHERE metric_code='delivery') AS delivery_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (metric_code='sale' OR metric_code='delivery')
  WHERE t.breakdown_level = 'region_l2' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone, t.region_l2
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
  COALESCE(a.sale_amount, 0) AS sale_actual,
  COALESCE(t.sale_target, 0) AS sale_target,
  round(COALESCE(a.sale_amount, 0) / NULLIF(COALESCE(t.sale_target, 0), 0), 4) AS sale_rate,
  COALESCE(a.daily_sale, 0) AS daily_sale,
  COALESCE(a.delivery_amount, 0) AS delivery_actual,
  COALESCE(t.delivery_target, 0) AS delivery_target,
  round(COALESCE(a.delivery_amount, 0) / NULLIF(COALESCE(t.delivery_target, 0), 0), 4) AS delivery_rate,
  COALESCE(a.daily_delivery, 0) AS daily_delivery,
  round((COALESCE(t.sale_target, 0) - COALESCE(a.sale_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_sale_target,
  round((COALESCE(t.delivery_target, 0) - COALESCE(a.delivery_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_delivery_target
FROM region_act a LEFT JOIN region_tgt t ON t.target_id = a.target_id AND t.war_zone = a.war_zone
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
  COALESCE(a.sale_amount, 0) AS sale_actual,
  COALESCE(t.sale_target, 0) AS sale_target,
  round(COALESCE(a.sale_amount, 0) / NULLIF(COALESCE(t.sale_target, 0), 0), 4) AS sale_rate,
  COALESCE(a.daily_sale, 0) AS daily_sale,
  COALESCE(a.delivery_amount, 0) AS delivery_actual,
  COALESCE(t.delivery_target, 0) AS delivery_target,
  round(COALESCE(a.delivery_amount, 0) / NULLIF(COALESCE(t.delivery_target, 0), 0), 4) AS delivery_rate,
  COALESCE(a.daily_delivery, 0) AS daily_delivery,
  round((COALESCE(t.sale_target, 0) - COALESCE(a.sale_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_sale_target,
  round((COALESCE(t.delivery_target, 0) - COALESCE(a.delivery_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_delivery_target
FROM sub_region_act a LEFT JOIN sub_region_tgt t ON t.target_id = a.target_id AND t.war_zone = a.war_zone AND t.region_l2 = a.region_l2
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
  COALESCE(a.sale_amount, 0) AS sale_actual,
  COALESCE(a.sale_target, 0) AS sale_target,
  round(COALESCE(a.sale_amount, 0) / NULLIF(COALESCE(a.sale_target, 0), 0), 4) AS sale_rate,
  COALESCE(a.daily_sale, 0) AS daily_sale,
  COALESCE(a.delivery_amount, 0) AS delivery_actual,
  COALESCE(a.delivery_target, 0) AS delivery_target,
  round(COALESCE(a.delivery_amount, 0) / NULLIF(COALESCE(a.delivery_target, 0), 0), 4) AS delivery_rate,
  COALESCE(a.daily_delivery, 0) AS daily_delivery,
  round((COALESCE(a.sale_target, 0) - COALESCE(a.sale_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_sale_target,
  round((COALESCE(a.delivery_target, 0) - COALESCE(a.delivery_amount, 0)) / NULLIF(COALESCE(a.total_days, 0) - COALESCE(a.days_elapsed, 0), 0), 2) AS remaining_daily_delivery_target
FROM leaf_rows a;

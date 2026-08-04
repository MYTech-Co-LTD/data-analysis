DROP VIEW IF EXISTS report_achievement_gen CASCADE;
CREATE VIEW report_achievement_gen AS
WITH tgt AS (
  SELECT id, name, status, start_date, end_date, closed_at, system_book_code, branch_num,
    target_level, parent_target_id, target_type, category, breakdown_level, war_zone, region_l2,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed
  FROM targets WHERE target_level = 'total'
),
sale AS (
  SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(r.total_sale), 0) FROM report_daily_sales r
    WHERE (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
      AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = r.branch_num AND db.system_book_code = r.system_book_code AND is_assessed_war_zone(db.first_level_region))
  ) AS actual_value,
  (SELECT count(DISTINCT r.biz_date) FROM report_daily_sales r
    WHERE (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
      AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = r.branch_num AND db.system_book_code = r.system_book_code AND is_assessed_war_zone(db.first_level_region))
  ) AS days
FROM targets t
),
delivery AS (
  SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(d.out_money), 0) + COALESCE((
      SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
      WHERE w.system_book_code = '64188' AND w.biz_date BETWEEN t.start_date AND t.end_date
        AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))
    ), 0) FROM report_daily_delivery d
    WHERE (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
      AND d.biz_date BETWEEN t.start_date AND t.end_date
      AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = d.branch_num AND db.system_book_code = d.system_book_code AND is_assessed_war_zone(db.first_level_region))
  ) AS actual_value,
  (SELECT count(DISTINCT d.biz_date) FROM report_daily_delivery d
    WHERE (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
      AND d.biz_date BETWEEN t.start_date AND t.end_date
      AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = d.branch_num AND db.system_book_code = d.system_book_code AND is_assessed_war_zone(db.first_level_region))
  ) AS days
FROM targets t
),
outbound_amt AS (
  SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(COALESCE(d.out_money, 0) + COALESCE(w.wholesale_money, 0)), 0)
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  ) AS actual_value,
  (SELECT count(DISTINCT COALESCE(d.biz_date, w.biz_date))
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  ) AS days
FROM targets t
),
outbound_profit AS (
  SELECT t.id AS target_id,
  (SELECT CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
     THEN COALESCE(SUM(COALESCE(d.profit_money, 0) + COALESCE(w.wholesale_profit, 0)), 0) ELSE NULL END
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  ) AS actual_value,
  (SELECT count(DISTINCT COALESCE(d.biz_date, w.biz_date))
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  ) AS days
FROM targets t
)
SELECT t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
  t.system_book_code, t.branch_num, t.target_level, t.parent_target_id, t.target_type, t.category,
  t.breakdown_level, t.war_zone, t.region_l2,
  b.branch_name, b.first_level_region AS war_zone_dim, b.second_level_region AS region_l2_dim, b.region_name, b.city,
  mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
  CASE WHEN t.status = 'closed' THEN sn.actual_value
       WHEN md.metric_code = 'sale' AND md.data_ready THEN sale.actual_value
       WHEN md.metric_code = 'delivery' AND md.data_ready THEN delivery.actual_value
       WHEN md.metric_code = 'outbound_amt' AND md.data_ready THEN outbound_amt.actual_value
       WHEN md.metric_code = 'outbound_profit' AND md.data_ready THEN outbound_profit.actual_value END AS actual_value,
  CASE WHEN t.status = 'closed' THEN sn.data_status
       WHEN md.metric_code = 'sale' AND md.data_ready THEN
         CASE WHEN sale.days = 0 THEN 'missing' WHEN sale.days < t.total_days THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code = 'delivery' AND md.data_ready THEN
         CASE WHEN delivery.days = 0 THEN 'missing' WHEN delivery.days < t.total_days THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code = 'outbound_amt' AND md.data_ready THEN
         CASE WHEN outbound_amt.days = 0 THEN 'missing' WHEN outbound_amt.days < t.total_days THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code = 'outbound_profit' AND md.data_ready THEN
         CASE WHEN outbound_profit.days = 0 THEN 'missing' WHEN outbound_profit.days < t.total_days THEN 'partial' ELSE 'complete' END ELSE 'not_ready' END AS data_status,
  t.total_days, t.days_elapsed,
  CASE WHEN mv.target_value > 0 AND t.status = 'closed' THEN sn.achievement_rate
       WHEN mv.target_value > 0 AND md.metric_code = 'sale' AND md.data_ready AND sale.actual_value IS NOT NULL THEN round((sale.actual_value / mv.target_value)::numeric, 4)
       WHEN mv.target_value > 0 AND md.metric_code = 'delivery' AND md.data_ready AND delivery.actual_value IS NOT NULL THEN round((delivery.actual_value / mv.target_value)::numeric, 4)
       WHEN mv.target_value > 0 AND md.metric_code = 'outbound_amt' AND md.data_ready AND outbound_amt.actual_value IS NOT NULL THEN round((outbound_amt.actual_value / mv.target_value)::numeric, 4)
       WHEN mv.target_value > 0 AND md.metric_code = 'outbound_profit' AND md.data_ready AND outbound_profit.actual_value IS NOT NULL THEN round((outbound_profit.actual_value / mv.target_value)::numeric, 4) END AS achievement_rate,
  CASE WHEN t.total_days > 0 THEN round(t.days_elapsed::numeric / t.total_days, 4) ELSE NULL END AS progress_rate
FROM tgt t
JOIN target_metric_values mv ON mv.target_id = t.id
JOIN metric_definitions md ON md.metric_code = mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code = t.system_book_code AND b.branch_num = t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id = t.id AND sn.metric_code = mv.metric_code
  LEFT JOIN sale ON sale.target_id = t.id AND md.metric_code = 'sale'
  LEFT JOIN delivery ON delivery.target_id = t.id AND md.metric_code = 'delivery'
  LEFT JOIN outbound_amt ON outbound_amt.target_id = t.id AND md.metric_code = 'outbound_amt'
  LEFT JOIN outbound_profit ON outbound_profit.target_id = t.id AND md.metric_code = 'outbound_profit';


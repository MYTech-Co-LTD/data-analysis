DROP VIEW IF EXISTS report_achievement_gen CASCADE;
CREATE VIEW report_achievement_gen AS
WITH tgt AS (
  SELECT t.id, t.name, t.status, t.start_date, t.end_date, t.closed_at, t.system_book_code, t.branch_num,
    t.target_level, t.parent_target_id, t.target_type, t.category, t.breakdown_level, t.war_zone, t.region_l2,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t WHERE t.target_level = 'total' AND (t.branch_num = 'ALL' OR scope_match_v2('brands', t.system_book_code) AND (scope_match_v2('branch_nums', t.branch_num::text) OR scope_match_v2('branch_nums', t.system_book_code || '-' || t.branch_num)))
),
sale AS MATERIALIZED (
  SELECT t.id AS target_id,
  COALESCE(SUM(r.total_sale), 0) AS actual_value,
  count(DISTINCT r.biz_date) AS days
FROM targets t
LEFT JOIN report_daily_sales r
  ON (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
  AND r.biz_date BETWEEN t.start_date AND t.end_date
  AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = r.branch_num AND db.system_book_code = r.system_book_code AND is_assessed_war_zone(db.first_level_region))
  AND scope_match_v2('brands', r.system_book_code) AND (scope_match_v2('branch_nums', r.branch_num::text) OR scope_match_v2('branch_nums', r.system_book_code || '-' || r.branch_num))
WHERE t.target_level = 'total'
GROUP BY t.id
),
delivery AS MATERIALIZED (
  SELECT t.id AS target_id,
  COALESCE(SUM(d.out_money), 0) + COALESCE((
      SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
      WHERE w.system_book_code = '64188' AND w.biz_date BETWEEN t.start_date AND t.end_date
        AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))
        AND scope_match_v2('brands', w.system_book_code)
    ), 0) AS actual_value,
  count(DISTINCT d.biz_date) AS days
FROM targets t
LEFT JOIN report_daily_delivery d
  ON (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
  AND d.biz_date BETWEEN t.start_date AND t.end_date
  AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = d.branch_num AND db.system_book_code = d.system_book_code AND is_assessed_war_zone(db.first_level_region))
  AND scope_match_v2('brands', d.system_book_code) AND (scope_match_v2('branch_nums', d.branch_num::text) OR scope_match_v2('branch_nums', d.system_book_code || '-' || d.branch_num))
WHERE t.target_level = 'total'
GROUP BY t.id
),
outbound_amt AS MATERIALIZED (
  SELECT t.id AS target_id,
  COALESCE(SUM(COALESCE(d.out_money, 0) + COALESCE(w.wholesale_money, 0)), 0) AS actual_value,
  count(DISTINCT COALESCE(d.biz_date, w.biz_date)) AS days
FROM targets t
LEFT JOIN report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
  ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
  ON (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
  AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
  AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  AND scope_match_v2('brands', COALESCE(d.system_book_code, w.system_book_code)) AND (scope_match_v2('branch_nums', COALESCE(d.branch_num, w.branch_num)::text) OR scope_match_v2('branch_nums', COALESCE(d.system_book_code, w.system_book_code) || '-' || COALESCE(d.branch_num, w.branch_num)))
WHERE t.target_level = 'total'
GROUP BY t.id
),
outbound_profit AS MATERIALIZED (
  SELECT t.id AS target_id,
  CASE WHEN can_cost_visible()
     THEN COALESCE(SUM(COALESCE(d.profit_money, 0) + COALESCE(w.wholesale_profit, 0)), 0) ELSE NULL END AS actual_value,
  count(DISTINCT COALESCE(d.biz_date, w.biz_date)) AS days
FROM targets t
LEFT JOIN report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
  ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
  ON (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
  AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
  AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  AND scope_match_v2('brands', COALESCE(d.system_book_code, w.system_book_code)) AND (scope_match_v2('branch_nums', COALESCE(d.branch_num, w.branch_num)::text) OR scope_match_v2('branch_nums', COALESCE(d.system_book_code, w.system_book_code) || '-' || COALESCE(d.branch_num, w.branch_num)))
WHERE t.target_level = 'total'
GROUP BY t.id
),
scoped_tgt AS MATERIALIZED (
  SELECT t.parent_target_id AS target_id,
    SUM(tmv.target_value) FILTER (WHERE tmv.metric_code = 'sale') AS sale,
    SUM(tmv.target_value) FILTER (WHERE tmv.metric_code = 'delivery') AS delivery
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id
  WHERE t.breakdown_level = 'store' AND t.branch_num <> 'ALL' AND scope_match_v2('brands', t.system_book_code) AND (scope_match_v2('branch_nums', t.branch_num::text) OR scope_match_v2('branch_nums', t.system_book_code || '-' || t.branch_num))
  GROUP BY t.parent_target_id
)
SELECT t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
  t.system_book_code, t.branch_num, t.target_level, t.parent_target_id, t.target_type, t.category,
  t.breakdown_level, t.war_zone, t.region_l2,
  b.branch_name, b.first_level_region AS war_zone_dim, b.second_level_region AS region_l2_dim, b.region_name, b.city,
  mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, CASE
       WHEN branch_scope_limited() AND md.metric_code = 'sale' THEN COALESCE(scoped_tgt.sale, mv.target_value)
       WHEN branch_scope_limited() AND md.metric_code = 'delivery' THEN COALESCE(scoped_tgt.delivery, mv.target_value)
       WHEN branch_scope_limited() AND md.metric_code = 'outbound_amt' THEN mv.target_value
       WHEN branch_scope_limited() AND md.metric_code = 'outbound_profit' THEN mv.target_value
       ELSE mv.target_value END AS target_value,
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
       WHEN COALESCE(scoped_tgt.sale, mv.target_value) > 0 AND md.metric_code = 'sale' AND md.data_ready AND sale.actual_value IS NOT NULL AND (NOT branch_scope_limited() OR md.metric_code IN ('sale', 'delivery')) THEN round((sale.actual_value / COALESCE(scoped_tgt.sale, mv.target_value))::numeric, 4)
       WHEN COALESCE(scoped_tgt.delivery, mv.target_value) > 0 AND md.metric_code = 'delivery' AND md.data_ready AND delivery.actual_value IS NOT NULL AND (NOT branch_scope_limited() OR md.metric_code IN ('sale', 'delivery')) THEN round((delivery.actual_value / COALESCE(scoped_tgt.delivery, mv.target_value))::numeric, 4)
       WHEN mv.target_value > 0 AND md.metric_code = 'outbound_amt' AND md.data_ready AND outbound_amt.actual_value IS NOT NULL AND (NOT branch_scope_limited() OR md.metric_code IN ('sale', 'delivery')) THEN round((outbound_amt.actual_value / mv.target_value)::numeric, 4)
       WHEN mv.target_value > 0 AND md.metric_code = 'outbound_profit' AND md.data_ready AND outbound_profit.actual_value IS NOT NULL AND (NOT branch_scope_limited() OR md.metric_code IN ('sale', 'delivery')) THEN round((outbound_profit.actual_value / mv.target_value)::numeric, 4) END AS achievement_rate,
  CASE WHEN t.total_days > 0 THEN round(t.days_elapsed::numeric / t.total_days, 4) ELSE NULL END AS progress_rate
FROM tgt t
JOIN target_metric_values mv ON mv.target_id = t.id
JOIN metric_definitions md ON md.metric_code = mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code = t.system_book_code AND b.branch_num = t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id = t.id AND sn.metric_code = mv.metric_code
  LEFT JOIN sale ON sale.target_id = t.id AND md.metric_code = 'sale'
  LEFT JOIN delivery ON delivery.target_id = t.id AND md.metric_code = 'delivery'
  LEFT JOIN outbound_amt ON outbound_amt.target_id = t.id AND md.metric_code = 'outbound_amt'
  LEFT JOIN outbound_profit ON outbound_profit.target_id = t.id AND md.metric_code = 'outbound_profit'
LEFT JOIN scoped_tgt ON scoped_tgt.target_id = t.id;


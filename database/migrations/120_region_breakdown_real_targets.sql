-- 120_region_breakdown_real_targets.sql
-- 重建 report_region_breakdown_v：三级目标用 target_metric_values 真实分解值（不再平摊/整桶）；
--   delivery = 调拨(3120门店) + 品品甜批发(64188门店收货方)，与品牌表/KPI 一致；
--   公式照 metric_registry（迁移119）实现。
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；security_invoker；部署后 restart postgrest。
DROP VIEW IF EXISTS report_region_breakdown_v;
CREATE VIEW report_region_breakdown_v AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
         (end_date - start_date + 1) AS total_days,
         GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
         LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
),
store_tgt AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code, t.branch_num,
         db.first_level_region AS war_zone, db.second_level_region AS region_l2,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  JOIN dim_branch db ON db.system_book_code=t.system_book_code AND db.branch_num=t.branch_num
  WHERE t.breakdown_level='store' AND t.branch_num<>'ALL' AND is_assessed_war_zone(db.first_level_region)
  GROUP BY t.parent_target_id, t.system_book_code, t.branch_num, db.first_level_region, db.second_level_region
),
region_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone, t.region_l2,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  WHERE t.breakdown_level='region_l2' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone, t.region_l2
),
wz_tgt AS (
  SELECT t.parent_target_id AS target_id, t.war_zone,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='sale') AS sale_target,
         MAX(tmv.target_value) FILTER (WHERE tmv.metric_code='delivery') AS delivery_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id AND tmv.metric_code IN ('sale','delivery')
  WHERE t.breakdown_level='war_zone' AND is_assessed_war_zone(t.war_zone)
  GROUP BY t.parent_target_id, t.war_zone
),
sale_act AS (
  SELECT tgt.target_id, r.system_book_code, r.branch_num,
         SUM(r.total_sale) AS sale_actual,
         SUM(CASE WHEN r.biz_date=tgt.latest_day THEN r.total_sale ELSE 0 END) AS daily_sale
  FROM tgt JOIN report_daily_sales r ON r.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code=r.system_book_code AND db.branch_num=r.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, r.system_book_code, r.branch_num
),
dlv_3120 AS (
  SELECT tgt.target_id, d.system_book_code, d.branch_num,
         SUM(d.out_money) AS delivery_actual,
         SUM(CASE WHEN d.biz_date=tgt.latest_day THEN d.out_money ELSE 0 END) AS daily_delivery
  FROM tgt JOIN report_daily_delivery d ON d.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code=d.system_book_code AND db.branch_num=d.branch_num
  WHERE is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, d.system_book_code, d.branch_num
),
dlv_64188 AS (
  SELECT tgt.target_id, '64188' AS system_book_code, db.branch_num,
         SUM(w.wholesale_amount) AS delivery_actual,
         SUM(CASE WHEN w.biz_date=tgt.latest_day THEN w.wholesale_amount ELSE 0 END) AS daily_delivery
  FROM tgt JOIN report_daily_wholesale_customer w ON w.system_book_code='64188' AND w.biz_date BETWEEN tgt.start_date AND tgt.end_date
  JOIN dim_branch db ON db.system_book_code='64188' AND db.branch_name=w.client_name AND is_assessed_war_zone(db.first_level_region)
  GROUP BY tgt.target_id, db.branch_num
),
delivery_act AS (
  SELECT target_id, system_book_code, branch_num, SUM(delivery_actual) AS delivery_actual, SUM(daily_delivery) AS daily_delivery
  FROM (SELECT * FROM dlv_3120 UNION ALL SELECT * FROM dlv_64188) u
  GROUP BY target_id, system_book_code, branch_num
),
store_rows AS (
  SELECT tgt.target_id, 'store' AS level, db.second_level_region AS parent_code,
         db.first_level_region AS region_code, db.first_level_region AS region_name,
         db.second_level_region AS sub_region_code, db.second_level_region AS sub_region_name,
         db.branch_num, db.branch_name,
         COALESCE(st.sale_target,0) AS sale_target,
         COALESCE(sa.sale_actual,0) AS sale_actual,
         COALESCE(st.delivery_target,0) AS delivery_target,
         COALESCE(da.delivery_actual,0) AS delivery_actual,
         COALESCE(sa.daily_sale,0) AS daily_sale,
         COALESCE(da.daily_delivery,0) AS daily_delivery,
         tgt.total_days, tgt.days_elapsed,
         db.first_level_region AS war_zone, db.second_level_region AS region_l2
  FROM tgt CROSS JOIN dim_branch db
  LEFT JOIN store_tgt st ON st.target_id=tgt.target_id AND st.system_book_code=db.system_book_code AND st.branch_num=db.branch_num
  LEFT JOIN sale_act sa ON sa.target_id=tgt.target_id AND sa.system_book_code=db.system_book_code AND sa.branch_num=db.branch_num
  LEFT JOIN delivery_act da ON da.target_id=tgt.target_id AND da.system_book_code=db.system_book_code AND da.branch_num=db.branch_num
  WHERE db.is_active AND db.branch_num<>'99' AND is_assessed_war_zone(db.first_level_region)
),
region_rows AS (
  SELECT tgt.target_id, 'sub_region' AS level, rt.war_zone AS parent_code,
         rt.war_zone AS region_code, rt.war_zone AS region_name,
         rt.region_l2 AS sub_region_code, rt.region_l2 AS sub_region_name,
         NULL::text AS branch_num, NULL::text AS branch_name,
         COALESCE(rt.sale_target,0) AS sale_target,
         COALESCE(SUM(sr.sale_actual),0) AS sale_actual,
         COALESCE(rt.delivery_target,0) AS delivery_target,
         COALESCE(SUM(sr.delivery_actual),0) AS delivery_actual,
         COALESCE(SUM(sr.daily_sale),0) AS daily_sale,
         COALESCE(SUM(sr.daily_delivery),0) AS daily_delivery,
         MAX(sr.total_days) AS total_days, MAX(sr.days_elapsed) AS days_elapsed,
         rt.war_zone AS war_zone, rt.region_l2 AS region_l2
  FROM tgt JOIN region_tgt rt ON rt.target_id=tgt.target_id
  LEFT JOIN store_rows sr ON sr.target_id=tgt.target_id AND sr.region_l2=rt.region_l2 AND sr.war_zone=rt.war_zone
  GROUP BY tgt.target_id, rt.war_zone, rt.region_l2, rt.sale_target, rt.delivery_target
),
wz_rows AS (
  SELECT tgt.target_id, 'region' AS level, NULL::text AS parent_code,
         wt.war_zone AS region_code, wt.war_zone AS region_name,
         NULL::text AS sub_region_code, NULL::text AS sub_region_name,
         NULL::text AS branch_num, NULL::text AS branch_name,
         COALESCE(wt.sale_target,0) AS sale_target,
         COALESCE(SUM(sr.sale_actual),0) AS sale_actual,
         COALESCE(wt.delivery_target,0) AS delivery_target,
         COALESCE(SUM(sr.delivery_actual),0) AS delivery_actual,
         COALESCE(SUM(sr.daily_sale),0) AS daily_sale,
         COALESCE(SUM(sr.daily_delivery),0) AS daily_delivery,
         MAX(sr.total_days) AS total_days, MAX(sr.days_elapsed) AS days_elapsed,
         wt.war_zone AS war_zone, NULL::text AS region_l2
  FROM tgt JOIN wz_tgt wt ON wt.target_id=tgt.target_id
  LEFT JOIN store_rows sr ON sr.target_id=tgt.target_id AND sr.war_zone=wt.war_zone
  GROUP BY tgt.target_id, wt.war_zone, wt.sale_target, wt.delivery_target
),
all_rows AS (
  SELECT * FROM store_rows
  UNION ALL SELECT * FROM region_rows
  UNION ALL SELECT * FROM wz_rows
)
SELECT target_id, level, parent_code, region_code, region_name, sub_region_code, sub_region_name,
       branch_num, branch_name,
       sale_target, sale_actual,
       CASE WHEN sale_target>0 THEN round(sale_actual/nullif(sale_target,0),4) END AS sale_rate,
       delivery_target, delivery_actual,
       CASE WHEN delivery_target>0 THEN round(delivery_actual/nullif(delivery_target,0),4) END AS delivery_rate,
       daily_sale, daily_delivery,
       CASE WHEN total_days>days_elapsed AND sale_target>0 THEN round((sale_target-sale_actual)/(total_days-days_elapsed),2) END AS remaining_daily_sale_target,
       CASE WHEN total_days>days_elapsed AND delivery_target>0 THEN round((delivery_target-delivery_actual)/(total_days-days_elapsed),2) END AS remaining_daily_delivery_target
FROM all_rows;
ALTER VIEW report_region_breakdown_v OWNER TO postgres;
ALTER VIEW report_region_breakdown_v SET (security_invoker=true);
GRANT SELECT ON report_region_breakdown_v TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 120: region_breakdown_v 真实三级目标 + delivery 含品品甜'; END $$;

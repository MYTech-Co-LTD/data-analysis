-- 096_achievement_delivery_pure.sql
-- 修复 report_achievement_v 的 delivery LATERAL：去掉 UNION ALL wholesale，对齐 088 delivery 定义
--   问题(070原版)：delivery_actual = SUM(delivery.out_money) + SUM(wholesale.wholesale_money)（含批发，偏高）
--   修复：delivery_actual = 仅 SUM(report_daily_delivery.out_money)（配送调拨，不含批发）
--   口径：088 delivery = 总部→熊喵门店（配送调拨，is_assessed_war_zone 过滤），wholesale 单独
--   幂等：DROP VIEW IF EXISTS + CREATE VIEW（重写 070，仅 delivery LATERAL 改，其余 sale/outbound/progress 不变）；部署后 restart postgrest
--   关联：spec docs/superpowers/specs/2026-07-27-phase1-metric-alignment-design.md

DROP VIEW IF EXISTS report_achievement_v;

CREATE VIEW report_achievement_v AS
SELECT t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
  t.system_book_code, t.branch_num, t.target_level, t.parent_target_id, t.target_type, t.category,
  t.breakdown_level, t.war_zone, t.region_l2,
  b.branch_name, b.first_level_region AS war_zone_dim, b.second_level_region AS region_l2_dim, b.region_name, b.city,
  mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
  CASE WHEN t.status='closed' THEN sn.actual_value
       WHEN md.metric_code='sale' AND md.data_ready THEN sa.sale_actual
       WHEN md.metric_code='delivery' AND md.data_ready THEN dl.delivery_actual
       WHEN md.metric_code='outbound_amt' AND md.data_ready THEN ob.outbound_amt_actual
       WHEN md.metric_code='outbound_profit' AND md.data_ready THEN ob.outbound_profit_actual END AS actual_value,
  CASE WHEN t.status='closed' THEN sn.data_status
       WHEN md.metric_code='sale' AND md.data_ready THEN
         CASE WHEN sa.sale_days=0 THEN 'missing' WHEN sa.sale_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code='delivery' AND md.data_ready THEN
         CASE WHEN dl.delivery_days=0 THEN 'missing' WHEN dl.delivery_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       WHEN md.metric_code IN ('outbound_amt','outbound_profit') AND md.data_ready THEN
         CASE WHEN ob.outbound_days=0 THEN 'missing' WHEN ob.outbound_days<(t.end_date-t.start_date+1) THEN 'partial' ELSE 'complete' END
       ELSE 'not_ready' END AS data_status,
  (t.end_date-t.start_date+1) AS total_days,
  GREATEST(LEAST(current_date,t.end_date)-t.start_date+1,0) AS days_elapsed,
  CASE WHEN mv.target_value>0 AND t.status='closed' THEN sn.achievement_rate
       WHEN mv.target_value>0 AND md.metric_code='sale' AND md.data_ready AND sa.sale_actual IS NOT NULL THEN round((sa.sale_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='delivery' AND md.data_ready AND dl.delivery_actual IS NOT NULL THEN round((dl.delivery_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='outbound_amt' AND md.data_ready AND ob.outbound_amt_actual IS NOT NULL THEN round((ob.outbound_amt_actual/mv.target_value)::numeric,4)
       WHEN mv.target_value>0 AND md.metric_code='outbound_profit' AND md.data_ready AND ob.outbound_profit_actual IS NOT NULL THEN round((ob.outbound_profit_actual/mv.target_value)::numeric,4) END AS achievement_rate,
  -- progress_rate = 纯时间进度(当月第几天/当月总天数), 不再含 actual; 三色由前端按 achievement_rate 算
  round(EXTRACT(day FROM current_date)::numeric / EXTRACT(day FROM (date_trunc('month', current_date) + interval '1 month' - interval '1 day'))::numeric, 4) AS progress_rate
FROM targets t
JOIN target_metric_values mv ON mv.target_id=t.id
JOIN metric_definitions md ON md.metric_code=mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code=t.system_book_code AND b.branch_num=t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id=t.id AND sn.metric_code=mv.metric_code
LEFT JOIN LATERAL (
  SELECT SUM(r.total_sale) AS sale_actual, count(DISTINCT r.biz_date) AS sale_days
  FROM report_daily_sales r
  WHERE (t.system_book_code='ALL' OR r.system_book_code=t.system_book_code)
    AND r.biz_date BETWEEN t.start_date AND t.end_date
    AND (
      ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND is_assessed_war_zone(db.first_level_region)))
      OR (t.breakdown_level='store' AND (t.branch_num='ALL' OR r.branch_num=t.branch_num))
      OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone))
      OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=r.branch_num AND db.system_book_code=r.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
    )
) sa ON md.metric_code='sale'
LEFT JOIN LATERAL (
  -- 096 修复：delivery 仅 report_daily_delivery（去 UNION ALL wholesale）
  SELECT SUM(d.out_money) AS delivery_actual, count(DISTINCT d.biz_date) AS delivery_days
  FROM report_daily_delivery d
  WHERE (t.system_book_code='ALL' OR d.system_book_code=t.system_book_code)
    AND d.biz_date BETWEEN t.start_date AND t.end_date
    AND (
      ((t.breakdown_level IS NULL OR t.target_level='total') AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND is_assessed_war_zone(db.first_level_region)))
      OR (t.breakdown_level='store' AND d.branch_num=t.branch_num)
      OR (t.breakdown_level='war_zone' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone))
      OR (t.breakdown_level='region_l2' AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.branch_num=d.branch_num AND db.system_book_code=d.system_book_code AND db.first_level_region=t.war_zone AND db.second_level_region=t.region_l2))
    )
) dl ON md.metric_code='delivery'
LEFT JOIN LATERAL (
  SELECT SUM(COALESCE(d.out_money,0)+COALESCE(w.wholesale_money,0)) AS outbound_amt_actual,
    SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) AS outbound_profit_actual,
    count(DISTINCT COALESCE(d.biz_date,w.biz_date)) AS outbound_days
  FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
    ON d.system_book_code=w.system_book_code AND d.biz_date=w.biz_date AND d.branch_num=w.branch_num AND d.category_group=w.category_group
  WHERE (t.system_book_code='ALL' OR COALESCE(d.system_book_code,w.system_book_code)=t.system_book_code)
    AND COALESCE(d.biz_date,w.biz_date) BETWEEN t.start_date AND t.end_date
    AND ((t.category IS NOT NULL AND (d.category_group=t.category OR w.category_group=t.category))
         OR (t.category IS NULL AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))))
) ob ON md.metric_code IN ('outbound_amt','outbound_profit');
ALTER VIEW report_achievement_v OWNER TO postgres;
ALTER VIEW report_achievement_v SET (security_invoker=true);
GRANT SELECT ON report_achievement_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 096: achievement delivery LATERAL 去 wholesale（仅 report_daily_delivery，对齐 088）；sale/outbound/progress 不变'; END $$;

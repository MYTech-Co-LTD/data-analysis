-- 118_achievement_delivery_include_ppf.sql
-- 修 report_achievement_v 的 delivery 口径错配：
--   096 把 delivery 从"调拨+批发"改成"纯调拨"（去 wholesale 防 outbound 重叠），但去太狠——
--   品品甜的配送本来就是批发（外部客户，走 wholesale_detail，无 transfer），结果 delivery_actual
--   只剩 3120 调拨(838万)，漏了品品甜批发配送(409万)；而 delivery 目标(1144万)含品品甜(323万)→
--   完成率 73% 是 target含/actual不含 的口径错配。
--   修复：delivery_actual = SUM(调拨) + 品品甜收货方批发(64188, assessed)，仅 total 级叠加
--   （breakdown 级不加，免得每个门店行都加全量品品甜批发）。与品牌表 report_brand_metric_v 口径一致。
--   outbound 用 item_outbound 独立聚合(调拨+全批发)，不受影响，无重叠。
--   幂等：DROP VIEW IF EXISTS + CREATE VIEW（仅 delivery LATERAL 改）；部署后 restart postgrest。

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
  -- 118 修复：delivery = 调拨 + 品品甜收货方批发配送（仅 total 级叠加；品品甜是外部客户，其配送走 wholesale）
  SELECT COALESCE(SUM(d.out_money),0)
       + CASE WHEN (t.breakdown_level IS NULL OR t.target_level='total') THEN
           COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
                      WHERE w.system_book_code='64188' AND w.biz_date BETWEEN t.start_date AND t.end_date
                        AND EXISTS(SELECT 1 FROM dim_branch db WHERE db.system_book_code='64188' AND db.branch_name=w.client_name AND is_assessed_war_zone(db.first_level_region))),0)
         ELSE 0 END AS delivery_actual,
         count(DISTINCT d.biz_date) AS delivery_days
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
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false)
      THEN SUM(COALESCE(d.profit_money,0)+COALESCE(w.wholesale_profit,0)) ELSE NULL END AS outbound_profit_actual,
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

DO $$ BEGIN RAISE NOTICE 'Migration 118: achievement delivery 加回品品甜收货方批发配送(64188, total级)，修 target含/actual不含 口径错配'; END $$;

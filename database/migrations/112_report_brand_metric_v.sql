-- 112_report_brand_metric_v.sql
-- 品牌×指标表视图：按 active total 目标窗口，每品牌一行 + 合计行。
-- 销售: targets store目标 + report_daily_sales；配送品牌异源(3120=daily_delivery, 64188=wholesale_customer 收货方)；
--   profit 按 can_see_cost 脱敏；完成率时间进度调整；margin 原值重算。
-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；security_invoker；部署后 restart postgrest。
DROP VIEW IF EXISTS report_brand_metric_v;
CREATE VIEW report_brand_metric_v AS
WITH tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date,end_date)-start_date+1,0) AS days_elapsed
  FROM targets WHERE target_level='total' AND status='active'
),
sale_target AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code, SUM(tmv.target_value) AS sale_target
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id
  WHERE t.breakdown_level='store' AND tmv.metric_code='sale'
  GROUP BY t.parent_target_id, t.system_book_code
),
sale_actual AS (
  SELECT tgt.target_id, r.system_book_code, SUM(r.total_sale) AS sale_amount
  FROM tgt JOIN report_daily_sales r
    ON r.system_book_code IN ('3120','64188') AND r.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, r.system_book_code
),
delivery AS (
  SELECT tgt.target_id, '3120'::text AS system_book_code,
    SUM(d.out_money) AS delivery_amount, SUM(d.profit_money) AS delivery_profit
  FROM tgt JOIN report_daily_delivery d ON d.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id
  UNION ALL
  SELECT tgt.target_id, w.system_book_code,
    SUM(w.wholesale_amount), SUM(w.wholesale_profit)
  FROM tgt JOIN report_daily_wholesale_customer w
    ON w.system_book_code='64188' AND w.biz_date BETWEEN tgt.start_date AND tgt.end_date
  GROUP BY tgt.target_id, w.system_book_code
),
brand_rows AS (
  SELECT tgt.target_id, b.system_book_code, b.brand_name,
    COALESCE(st.sale_target,0) AS sale_target,
    COALESCE(sa.sale_amount,0) AS sale_amount,
    CASE WHEN COALESCE(st.sale_target,0)>0 AND tgt.days_elapsed>0
      THEN ROUND(COALESCE(sa.sale_amount,0)/(st.sale_target*tgt.days_elapsed/tgt.total_days),4) END AS sale_rate,
    COALESCE(d.delivery_amount,0) AS delivery_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false)
      THEN COALESCE(d.delivery_profit,0) END AS delivery_profit,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false) AND COALESCE(d.delivery_amount,0)>0
      THEN ROUND(COALESCE(d.delivery_profit,0)/NULLIF(d.delivery_amount,0),4) END AS delivery_margin
  FROM tgt CROSS JOIN dim_brand b
  LEFT JOIN sale_target st ON st.target_id=tgt.target_id AND st.system_book_code=b.system_book_code
  LEFT JOIN sale_actual sa ON sa.target_id=tgt.target_id AND sa.system_book_code=b.system_book_code
  LEFT JOIN delivery d ON d.target_id=tgt.target_id AND d.system_book_code=b.system_book_code
)
SELECT * FROM brand_rows
UNION ALL
SELECT br.target_id, '合计' AS system_book_code, NULL AS brand_name,
  SUM(br.sale_target) AS sale_target,
  SUM(br.sale_amount) AS sale_amount,
  CASE WHEN SUM(br.sale_target)>0 AND tgt.days_elapsed>0
    THEN ROUND(SUM(br.sale_amount)/(SUM(br.sale_target)*tgt.days_elapsed/tgt.total_days),4) END AS sale_rate,
  SUM(br.delivery_amount) AS delivery_amount,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false)
    THEN SUM(br.delivery_profit) END AS delivery_profit,
  CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost',true)::boolean,false) AND SUM(br.delivery_amount)>0
    THEN ROUND(SUM(br.delivery_profit)/NULLIF(SUM(br.delivery_amount),0),4) END AS delivery_margin
FROM brand_rows br JOIN tgt ON tgt.target_id=br.target_id
GROUP BY br.target_id, tgt.days_elapsed, tgt.total_days;
ALTER VIEW report_brand_metric_v OWNER TO postgres;
ALTER VIEW report_brand_metric_v SET (security_invoker=true);
GRANT SELECT ON report_brand_metric_v TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 112: report_brand_metric_v（品牌×指标表，3行/目标）'; END $$;

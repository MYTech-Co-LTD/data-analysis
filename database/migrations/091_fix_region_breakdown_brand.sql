-- 091_fix_region_breakdown_brand.sql
-- 修复 report_region_breakdown_v：branch_dim 缺 system_book_code，撞号 branch_num（50个门店）销售被翻倍累加
-- 根因：branch_dim 只选 branch_num，CROSS JOIN + LEFT JOIN sale_actuals 只按 branch_num 关联
--       撞号门店（3120/64188 同 branch_num）的 sale_actual 匹配到两条 branch_dim 行 → 翻倍
-- 修复：branch_dim 加 system_book_code；sale_actuals/delivery_actuals GROUP BY 加 system_book_code；
--       LEFT JOIN 加 AND sa.system_book_code = bd.system_book_code
-- 幂等: DROP VIEW IF EXISTS + CREATE VIEW；部署后重启 postgrest

DROP VIEW IF EXISTS report_region_breakdown_v;

CREATE VIEW report_region_breakdown_v AS
WITH
target_base AS (
  SELECT
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    t.target_level,
    t.breakdown_level,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = 'active'
    AND t.target_level IN ('total', 'breakdown')
),

sale_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'sale'
),

delivery_targets AS (
  SELECT tmv.target_id, tmv.target_value AS delivery_target
  FROM target_metric_values tmv
  WHERE tmv.metric_code = 'delivery'
),

-- 门店维表（含 system_book_code，242 行；JOIN 时按品牌+门店号关联避免撞号翻倍）
branch_dim AS (
  SELECT
    system_book_code,
    branch_num,
    branch_name,
    first_level_region AS war_zone,
    second_level_region AS region_l2
  FROM dim_branch
  WHERE is_assessed_war_zone(first_level_region)
),

-- 销售实际值（按门店+品牌+目标聚合）
sale_actuals AS (
  SELECT
    tb.target_id,
    rds.branch_num,
    rds.system_book_code,
    SUM(rds.total_sale) AS sale_actual,
    SUM(CASE WHEN rds.biz_date = tb.start_date + tb.days_elapsed - 1 THEN rds.total_sale ELSE 0 END) AS daily_sale
  FROM report_daily_sales rds
  JOIN target_base tb ON rds.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR rds.system_book_code = tb.system_book_code)
  GROUP BY tb.target_id, rds.branch_num, rds.system_book_code
),

-- 出库实际值（按门店+品牌+目标聚合）
delivery_actuals AS (
  SELECT
    tb.target_id,
    d.branch_num,
    d.system_book_code,
    SUM(COALESCE(d.out_money, 0)) AS delivery_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN COALESCE(d.out_money, 0) ELSE 0 END) AS daily_delivery
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR d.system_book_code = tb.system_book_code)
  GROUP BY tb.target_id, d.branch_num, d.system_book_code
),

-- 门店层（total 目标：目标值均分；store 子目标：取自身）
store_level AS (
  SELECT
    tb.target_id,
    'store' AS level,
    bd.region_l2 AS parent_code,
    bd.war_zone AS region_code,
    bd.war_zone AS region_name,
    bd.region_l2 AS sub_region_code,
    bd.region_l2 AS sub_region_name,
    bd.branch_num,
    bd.branch_name,
    COALESCE(st.sale_target, 0) / (SELECT COUNT(*) FROM branch_dim) AS sale_target,
    COALESCE(sa.sale_actual, 0) AS sale_actual,
    CASE WHEN st.sale_target > 0 THEN ROUND(sa.sale_actual / (st.sale_target / (SELECT COUNT(*) FROM branch_dim)), 4) ELSE NULL END AS sale_rate,
    COALESCE(dt.delivery_target, 0) / (SELECT COUNT(*) FROM branch_dim) AS delivery_target,
    COALESCE(da.delivery_actual, 0) AS delivery_actual,
    CASE WHEN dt.delivery_target > 0 THEN ROUND(da.delivery_actual / (dt.delivery_target / (SELECT COUNT(*) FROM branch_dim)), 4) ELSE NULL END AS delivery_rate,
    COALESCE(sa.daily_sale, 0) AS daily_sale,
    COALESCE(da.daily_delivery, 0) AS daily_delivery,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND st.sale_target > 0
      THEN ROUND((st.sale_target / (SELECT COUNT(*) FROM branch_dim) - sa.sale_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_sale_target,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND dt.delivery_target > 0
      THEN ROUND((dt.delivery_target / (SELECT COUNT(*) FROM branch_dim) - da.delivery_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_delivery_target
  FROM target_base tb
  CROSS JOIN branch_dim bd
  LEFT JOIN sale_targets st ON st.target_id = tb.target_id
  LEFT JOIN sale_actuals sa ON sa.target_id = tb.target_id AND sa.branch_num = bd.branch_num AND sa.system_book_code = bd.system_book_code
  LEFT JOIN delivery_targets dt ON dt.target_id = tb.target_id
  LEFT JOIN delivery_actuals da ON da.target_id = tb.target_id AND da.branch_num = bd.branch_num AND da.system_book_code = bd.system_book_code
  WHERE tb.target_level = 'total'

  UNION ALL

  SELECT
    tb.target_id,
    'store' AS level,
    bd.region_l2 AS parent_code,
    bd.war_zone AS region_code,
    bd.war_zone AS region_name,
    bd.region_l2 AS sub_region_code,
    bd.region_l2 AS sub_region_name,
    bd.branch_num,
    bd.branch_name,
    COALESCE(st.sale_target, 0) AS sale_target,
    COALESCE(sa.sale_actual, 0) AS sale_actual,
    CASE WHEN st.sale_target > 0 THEN ROUND(sa.sale_actual / st.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(dt.delivery_target, 0) AS delivery_target,
    COALESCE(da.delivery_actual, 0) AS delivery_actual,
    CASE WHEN dt.delivery_target > 0 THEN ROUND(da.delivery_actual / dt.delivery_target, 4) ELSE NULL END AS delivery_rate,
    COALESCE(sa.daily_sale, 0) AS daily_sale,
    COALESCE(da.daily_delivery, 0) AS daily_delivery,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND st.sale_target > 0
      THEN ROUND((st.sale_target - sa.sale_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_sale_target,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND dt.delivery_target > 0
      THEN ROUND((dt.delivery_target - da.delivery_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_delivery_target
  FROM target_base tb
  CROSS JOIN branch_dim bd
  LEFT JOIN sale_targets st ON st.target_id = tb.target_id
  LEFT JOIN sale_actuals sa ON sa.target_id = tb.target_id AND sa.branch_num = bd.branch_num AND sa.system_book_code = bd.system_book_code
  LEFT JOIN delivery_targets dt ON dt.target_id = tb.target_id
  LEFT JOIN delivery_actuals da ON da.target_id = tb.target_id AND da.branch_num = bd.branch_num AND da.system_book_code = bd.system_book_code
  WHERE tb.target_level = 'breakdown' AND tb.breakdown_level = 'store'
),

sub_region_level AS (
  SELECT
    target_id, 'sub_region' AS level, region_code AS parent_code, region_code, region_name,
    sub_region_code, sub_region_name, NULL AS branch_num, NULL AS branch_name,
    SUM(sale_target) AS sale_target, SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target, SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale, SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM store_level
  GROUP BY target_id, region_code, region_name, sub_region_code, sub_region_name
),

region_level AS (
  SELECT
    target_id, 'region' AS level, NULL AS parent_code, region_code, region_name,
    NULL AS sub_region_code, NULL AS sub_region_name, NULL AS branch_num, NULL AS branch_name,
    SUM(sale_target) AS sale_target, SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(delivery_target) AS delivery_target, SUM(delivery_actual) AS delivery_actual,
    CASE WHEN SUM(delivery_target) > 0 THEN ROUND(SUM(delivery_actual) / SUM(delivery_target), 4) ELSE NULL END AS delivery_rate,
    SUM(daily_sale) AS daily_sale, SUM(daily_delivery) AS daily_delivery,
    SUM(remaining_daily_sale_target) AS remaining_daily_sale_target,
    SUM(remaining_daily_delivery_target) AS remaining_daily_delivery_target
  FROM sub_region_level
  GROUP BY target_id, region_code, region_name
)

SELECT * FROM region_level
UNION ALL
SELECT * FROM sub_region_level
UNION ALL
SELECT * FROM store_level;

ALTER VIEW report_region_breakdown_v OWNER TO postgres;
ALTER VIEW report_region_breakdown_v SET (security_invoker = true);
GRANT SELECT ON report_region_breakdown_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 091: region_breakdown_v 修复——branch_dim DISTINCT ON(branch_num) 去重 + JOIN 带 system_book_code'; END $$;

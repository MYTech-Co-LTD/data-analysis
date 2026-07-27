-- 095_category_summary_full_outbound.sql
-- 修复 report_category_summary_v：对齐 088 语义层 outbound 全口径
--   问题(074原版)：delivery 硬编码 system_book_code='64188'（delivery 表只有 3120 数据→空），
--                  wholesale 仅 64188 门店批发（漏外部批发）；实测合计 400万，应 ~1366万（漏 74%）
--   修复：delivery/wholesale 都按目标品牌过滤；wholesale 去掉 branch_num!='64188'（全门店+外部批发都算 outbound）
--   口径：outbound = delivery(配送) + wholesale_pp(门店批发) + wholesale_ext(外部批发)，按 category_group
--   幂等：DROP VIEW IF EXISTS + CREATE VIEW；部署后 restart postgrest
--   关联：spec docs/superpowers/specs/2026-07-27-phase1-metric-alignment-design.md

DROP VIEW IF EXISTS report_category_summary_v;

CREATE VIEW report_category_summary_v AS
WITH
target_base AS (
  SELECT
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = 'active' AND t.target_level = 'total' AND t.category IS NULL
),
outbound_amt_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv WHERE tmv.metric_code = 'outbound_amt'
),
outbound_profit_targets AS (
  SELECT tmv.target_id, tmv.target_value AS profit_target
  FROM target_metric_values tmv WHERE tmv.metric_code = 'outbound_profit'
),
category_actuals AS (
  -- delivery（总部→门店调拨，按目标品牌；delivery 表仅 3120 有数据）
  SELECT
    tb.target_id,
    d.category_group AS category,
    SUM(d.out_money) AS sale_actual,
    SUM(d.profit_money) AS profit_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.out_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.profit_money ELSE 0 END) AS daily_profit
  FROM report_daily_delivery d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR d.system_book_code = tb.system_book_code)
    AND d.category_group IN ('水果', '标品', '耗材')
  GROUP BY tb.target_id, d.category_group
  UNION ALL
  -- wholesale（批发，全门店+外部客户，按目标品牌；不再排除 branch_num）
  SELECT
    tb.target_id,
    w.category_group AS category,
    SUM(w.wholesale_money) AS sale_actual,
    SUM(w.wholesale_profit) AS profit_actual,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_profit ELSE 0 END) AS daily_profit
  FROM report_daily_wholesale w
  JOIN target_base tb ON w.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR w.system_book_code = tb.system_book_code)
    AND w.category_group IN ('水果', '标品', '耗材')
  GROUP BY tb.target_id, w.category_group
),
category_level AS (
  SELECT
    tb.target_id,
    ca.category,
    COALESCE(oat.sale_target, 0) AS sale_target,
    ca.sale_actual,
    CASE WHEN oat.sale_target > 0 THEN ROUND(ca.sale_actual / oat.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(opt.profit_target, 0) AS profit_target,
    ca.profit_actual,
    CASE WHEN opt.profit_target > 0 THEN ROUND(ca.profit_actual / opt.profit_target, 4) ELSE NULL END AS profit_rate,
    CASE WHEN ca.sale_actual > 0 THEN ROUND(ca.profit_actual / ca.sale_actual, 4) ELSE NULL END AS profit_margin,
    ca.daily_amount,
    ca.daily_profit,
    CASE WHEN ca.daily_amount > 0 THEN ROUND(ca.daily_profit / ca.daily_amount, 4) ELSE NULL END AS daily_profit_margin,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND opt.profit_target > 0
      THEN ROUND((opt.profit_target - ca.profit_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_profit_target
  FROM target_base tb
  CROSS JOIN (VALUES ('水果'), ('标品'), ('耗材')) AS cats(category)
  LEFT JOIN outbound_amt_targets oat ON oat.target_id = tb.target_id
  LEFT JOIN outbound_profit_targets opt ON opt.target_id = tb.target_id
  LEFT JOIN category_actuals ca ON ca.target_id = tb.target_id AND ca.category = cats.category
),
total_level AS (
  SELECT
    target_id,
    '合计' AS category,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(profit_target) AS profit_target,
    SUM(profit_actual) AS profit_actual,
    CASE WHEN SUM(profit_target) > 0 THEN ROUND(SUM(profit_actual) / SUM(profit_target), 4) ELSE NULL END AS profit_rate,
    CASE WHEN SUM(sale_actual) > 0 THEN ROUND(SUM(profit_actual) / SUM(sale_actual), 4) ELSE NULL END AS profit_margin,
    SUM(daily_amount) AS daily_amount,
    SUM(daily_profit) AS daily_profit,
    CASE WHEN SUM(daily_amount) > 0 THEN ROUND(SUM(daily_profit) / SUM(daily_amount), 4) ELSE NULL END AS daily_profit_margin,
    SUM(remaining_daily_profit_target) AS remaining_daily_profit_target
  FROM category_level
  GROUP BY target_id
)
SELECT * FROM category_level
UNION ALL
SELECT * FROM total_level;

ALTER VIEW report_category_summary_v OWNER TO postgres;
ALTER VIEW report_category_summary_v SET (security_invoker = true);
GRANT SELECT ON report_category_summary_v TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 095: category_summary 全口径 outbound（delivery+wholesale_pp+ext，按目标品牌）；实测修复前 400万→修复后 ~1366万'; END $$;

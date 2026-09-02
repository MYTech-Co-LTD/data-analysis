DROP VIEW IF EXISTS report_wholesale_customer_gen_qa;
CREATE VIEW report_wholesale_customer_gen_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
  SELECT 'wholesale_amount' AS metric,
    COALESCE((SELECT SUM(wholesale_amount) FROM report_wholesale_customer_gen WHERE 1=1), 0) AS view_sum,
    COALESCE((SELECT COALESCE(SUM(s.wholesale_amount), 0) FROM report_daily_wholesale_customer s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active','closed')), 0) AS ref_sum
) t;


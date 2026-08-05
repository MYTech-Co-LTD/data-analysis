DROP VIEW IF EXISTS report_wholesale_daily_gen_qa;
CREATE VIEW report_wholesale_daily_gen_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
  SELECT 'wholesale_ext_amount' AS metric,
    COALESCE((SELECT SUM(wholesale_ext_amount) FROM report_wholesale_daily_gen WHERE 1=1), 0) AS view_sum,
    COALESCE((SELECT COALESCE(SUM(s.wholesale_money), 0) FROM report_daily_wholesale s JOIN targets t ON s.biz_date BETWEEN t.start_date AND LEAST(current_date, t.end_date) AND t.target_level = 'total' AND t.status = 'active' WHERE s.system_book_code = '3120'), 0) AS ref_sum
) t;


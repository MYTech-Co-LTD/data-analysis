DROP VIEW IF EXISTS report_brand_metric_gen_qa;
CREATE VIEW report_brand_metric_gen_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
  SELECT 'sale_amount' AS metric,
    COALESCE((SELECT SUM(sale_amount) FROM report_brand_metric_gen WHERE system_book_code <> '合计'), 0) AS view_sum,
    COALESCE((SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active', 'closed') WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) AS ref_sum
) t;


DROP VIEW IF EXISTS report_region_breakdown_gen_qa;
CREATE VIEW report_region_breakdown_gen_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
  SELECT 'sale_actual' AS metric,
    COALESCE((SELECT SUM(sale_actual) FROM report_region_breakdown_gen WHERE level = 'store'), 0) AS view_sum,
    COALESCE((SELECT COALESCE(SUM(s.total_sale), 0) FROM report_daily_sales s JOIN targets t ON s.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active','closed') WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) AS ref_sum
  UNION ALL
  SELECT 'delivery_actual' AS metric,
    COALESCE((SELECT SUM(delivery_actual) FROM report_region_breakdown_gen WHERE level = 'store'), 0) AS view_sum,
    COALESCE((SELECT COALESCE((SELECT SUM(d.out_money) FROM report_daily_delivery d JOIN targets t ON d.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active','closed') WHERE EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = d.system_book_code AND db.branch_num = d.branch_num AND is_assessed_war_zone(db.first_level_region))), 0) + COALESCE((SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w JOIN targets t ON w.biz_date BETWEEN t.start_date AND t.end_date AND t.target_level = 'total' AND t.status IN ('active','closed') WHERE w.system_book_code = '64188' AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))), 0)), 0) AS ref_sum
) t;


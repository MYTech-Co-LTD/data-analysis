-- 导出 parent 22 下、共享 branch_num 的门店目标清单，交用户逐个确认归属
WITH tgt AS (SELECT DISTINCT parent_target_id, branch_num FROM targets WHERE breakdown_level='store' AND parent_target_id=22)
SELECT t.parent_target_id, t.branch_num,
       d3120.branch_name AS store_3120_name, d64188.branch_name AS store_64188_name,
       t.system_book_code AS current_sbc, (SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id) AS current_metrics
FROM tgt JOIN targets t ON t.parent_target_id=tgt.parent_target_id AND t.breakdown_level='store' AND t.branch_num=tgt.branch_num
LEFT JOIN dim_branch d3120 ON d3120.system_book_code='3120' AND d3120.branch_num=t.branch_num
LEFT JOIN dim_branch d64188 ON d64188.system_book_code='64188' AND d64188.branch_num=t.branch_num
WHERE EXISTS (SELECT 1 FROM dim_branch WHERE branch_num=t.branch_num AND system_book_code='3120')
  AND EXISTS (SELECT 1 FROM dim_branch WHERE branch_num=t.branch_num AND system_book_code='64188')
ORDER BY t.branch_num;

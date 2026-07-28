-- 回归测试：共享 branch_num 的两品牌门店，upsert 后应得两行、system_book_code 各正确、互不覆盖。
-- 自包含：BEGIN 内 seed dim_branch + parent target，ROLLBACK 不留痕。
-- 不参与部署（_regression 目录被 migrate.sh 忽略，仅 glob 顶层 *.sql）。
-- 本地手动跑：docker exec -i deploy-postgres-1 psql -U postgres -d insforge < 此文件
\set ON_ERROR_STOP on
BEGIN;

-- (a) seed dim_branch：3120 与 64188 共享 branch_num=48 的两个物理门店
INSERT INTO dim_branch(system_book_code, branch_num, branch_name, first_level_region, second_level_region)
VALUES
  ('3120','48','曲靖师宗1店','云南战区','曲靖'),
  ('64188','48','品品甜昆明1店','云南战区','昆明');

-- (b) seed 父级 total target，捕获 id
WITH ins AS (
  INSERT INTO targets(name, system_book_code, branch_num, start_date, end_date, status, target_level, target_type, breakdown_level, created_by)
  VALUES ('Regression-Parent','ALL','ALL','2026-01-01','2026-12-31','active','total','store',NULL,'regression_setup')
  RETURNING id
)
SELECT id AS parent_id FROM ins
\gset

\echo '=== 调用 upsert_target_breakdown（共享 branch_num=48，两品牌门店） ==='
SELECT upsert_target_breakdown(
  :parent_id, 'ALL',
  '[{"breakdown_level":"store","system_book_code":"3120","branch_num":"48","metrics":{"sale":100,"delivery":50}},
    {"breakdown_level":"store","system_book_code":"64188","branch_num":"48","metrics":{"sale":200,"delivery":80}}]'::jsonb,
  'regression_test') AS upsert_result;

-- (d) 断言：branch_num=48 下应有 2 行 store target，system_book_code 各正确，metrics 各自独立
\echo '=== 期望：2 行（3120/48 sale=100 delivery=50；64188/48 sale=200 delivery=80），互不覆盖 ==='
SELECT t.system_book_code, t.branch_num, t.breakdown_level,
       (SELECT jsonb_object_agg(metric_code,target_value ORDER BY metric_code)
        FROM target_metric_values mv WHERE mv.target_id=t.id) AS metrics
FROM targets t
WHERE t.parent_target_id=:parent_id AND t.breakdown_level='store' AND t.branch_num='48'
ORDER BY t.system_book_code;

-- 计数断言
\echo '=== 期望：count=2 ==='
SELECT count(*) AS store_rows_for_branchnum_48
FROM targets
WHERE parent_target_id=:parent_id AND breakdown_level='store' AND branch_num='48';

ROLLBACK;
\echo '=== ROLLBACK 完成（不留痕） ==='

-- 101_cleanup_orphan_targets.sql
-- 清理 store 级孤儿目标：branch_num 在 dim_branch 查无（门店已关/改名）。
-- 单 DELETE：target_metric_values 经 ON DELETE CASCADE 级联删除（FK confdeltype='c' 已验证）。
-- 幂等（无则不删）。注：当前 prod 在此定义下(branch_num<>'ALL') 0 孤儿——本迁移为 future-proofing no-op。
DELETE FROM targets
WHERE breakdown_level='store' AND branch_num<>'ALL'
  AND NOT EXISTS (
    SELECT 1 FROM dim_branch d
    WHERE d.system_book_code=targets.system_book_code AND d.branch_num=targets.branch_num
  );
DO $$ BEGIN RAISE NOTICE 'Migration 101: 清理孤儿 store 目标(单DELETE+cascade)'; END $$;

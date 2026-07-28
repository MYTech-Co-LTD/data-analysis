-- 100_targets_branch_number_fk.sql
-- targets 加门店级 branch_number(生成,仅store级) + FK(NOT VALID,容历史) + 部分唯一索引
-- 幂等：ADD COLUMN IF NOT EXISTS；约束 IF NOT EXISTS；部署后 restart postgrest
ALTER TABLE targets ADD COLUMN IF NOT EXISTS branch_number TEXT
  GENERATED ALWAYS AS (
    CASE WHEN breakdown_level='store' AND branch_num<>'ALL'
      THEN system_book_code || '-' || LPAD(branch_num, 4, '0')
      ELSE NULL END
  ) STORED;

-- FK：新插入/更新校验 branch_number 须存在于 dim_branch；NOT VALID 不校验历史(79歧义+1孤儿)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='targets_branch_number_fkey') THEN
    ALTER TABLE targets ADD CONSTRAINT targets_branch_number_fkey
      FOREIGN KEY (branch_number) REFERENCES dim_branch(branch_number) NOT VALID;
  END IF;
END $$;

-- 同一父目标下，一个门店(branch_number)只能有一个 store 目标
CREATE UNIQUE INDEX IF NOT EXISTS idx_targets_parent_store_branch
  ON targets(parent_target_id, branch_number) WHERE breakdown_level='store';

DO $$ BEGIN RAISE NOTICE 'Migration 100: targets.branch_number + FK(NOT VALID) + partial unique'; END $$;

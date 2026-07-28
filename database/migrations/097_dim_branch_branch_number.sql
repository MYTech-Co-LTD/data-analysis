-- 097_dim_branch_branch_number.sql
-- 门店全局唯一开发键 branch_number：从复合PK(system_book_code,branch_num)派生
-- 幂等：ADD COLUMN IF NOT EXISTS；部署后 restart postgrest
ALTER TABLE dim_branch ADD COLUMN IF NOT EXISTS branch_number TEXT
  GENERATED ALWAYS AS (system_book_code || '-' || LPAD(branch_num, 4, '0')) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dim_branch_branch_number ON dim_branch(branch_number);

DO $$ BEGIN RAISE NOTICE 'Migration 097: dim_branch.branch_number (全局唯一开发键)'; END $$;

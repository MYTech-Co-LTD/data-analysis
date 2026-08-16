-- database/rollback/167_reverse.sql
-- 167 反向 + sunset 回滚（Task 20 演练物）：恢复 data_permissions（结构 + perm_freeze_snapshot 数据）
-- + 复授写权限 + 摘写关闭触发器 + 撤 sunset 旗标（perm-shadow job 恢复常态）。
-- claims/RLS 终版的回滚 = git revert 185 后走 GHA（migrate.sh 重跑 179/182/183 过渡版自动还原），
-- 本脚本只管表与数据。演练步骤见 docs/ops/iam-sunset-rollback-drill.md。
--
-- ⚠️ 与 plan（Task 20 Step 3）的两处适配（task20 report 取证）：
--  ① 结构按 072 真实 DDL 誊写：id SERIAL（非 BIGSERIAL）、无 UNIQUE(subject_type,subject_id)
--    （072 原文「故意不加：允许永久基础+多个临时扩展并存」）、含 expires_at 列（快照未冻结该列，
--    恢复行 expires_at=NULL=永久——冻结时点后过期的临时授权在回滚后复活，演练须知）；
--    原 plan 版 ON CONFLICT (subject_type,subject_id) 在无 UNIQUE 的真表上直接报错；
-- ② 幂等改「表空才插」守卫（重跑不重复灌快照行）+ DELETE sunset 旗标（185 ⑤所落，
--    不撤则 perm-shadow job 在回滚窗口仍 no-op）。
-- 快照列清单核对（information_schema，2026-08-16）：id/subject_type/subject_id/brands/categories/
--   branch_nums/can_see_cost/frozen_at——恢复投影取后六列（frozen_at 留快照自身做审计）。
BEGIN;
SET LOCAL app.bypass_perm_write = 'on';

CREATE TABLE IF NOT EXISTS data_permissions (
  id            SERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL,                    -- 'role' | 'user' | 'dept'
  subject_id    TEXT NOT NULL,                    -- role code | wecom_id | dept_id
  branch_nums   JSONB DEFAULT '["*"]'::jsonb,     -- 门店范围（"*" 通配；branch_number 值域）
  brands        JSONB DEFAULT '["*"]'::jsonb,     -- 品牌 system_book_code 范围
  categories    JSONB DEFAULT '["*"]'::jsonb,     -- 品类 category_group 范围
  can_see_cost  BOOLEAN DEFAULT false,
  expires_at    TIMESTAMPTZ,                      -- 临时授权时效（NULL=永久）
  note          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_data_permissions_subject ON data_permissions(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_data_permissions_expires ON data_permissions(expires_at) WHERE expires_at IS NOT NULL;
COMMENT ON TABLE data_permissions IS '[回滚态] 多维数据范围（sunset 前原表，072 DDL）——恢复自 perm_freeze_snapshot；授权已上收 Casdoor，禁新写入（见 184 写关闭语义）';

DO $g$
BEGIN
  IF to_regclass('public.data_permissions') IS NOT NULL
     AND (SELECT count(*) FROM data_permissions) = 0 THEN
    INSERT INTO data_permissions (subject_type, subject_id, branch_nums, brands, categories, can_see_cost, note)
    SELECT subject_type, subject_id, branch_nums, brands, categories, can_see_cost,
           'restored from freeze snapshot'
    FROM perm_freeze_snapshot;
    RAISE NOTICE '167_reverse: 恢复 % 行（perm_freeze_snapshot 基线）', (SELECT count(*) FROM data_permissions);
  ELSE
    RAISE NOTICE '167_reverse: 跳过灌数（表非空或快照缺失）';
  END IF;
END $g$;

GRANT SELECT, INSERT, UPDATE, DELETE ON data_permissions TO anon, authenticated;
DROP TRIGGER IF EXISTS trg_dp_write_close ON data_permissions;

-- 撤 sunset 旗标（perm-shadow job 恢复常态；185 ⑤在下次 sunset 后重落）
DELETE FROM system_flags WHERE key = 'data_permissions_sunset';

COMMIT;

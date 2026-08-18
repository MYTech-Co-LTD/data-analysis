-- 181_perm_backfill.sql
-- W4 / B4：存量回填工作台。回填三段（spec W4）：品牌/品类按角色或用户勾 resource；门店集合批量挂组+独立核对；
-- cost 进 field:cost。plan 行 status: pending→applied→checked（门店独立核对=第二列 checked_by）。
CREATE TABLE IF NOT EXISTS perm_backfill_plan (
  id          BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('grant-resource','attach-group','manual-review')),
  payload     JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','failed','checked')),
  checked_by  TEXT,                          -- 门店独立核对人（W4 退出判据「门店独立核对」留痕）
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backfill_subject ON perm_backfill_plan(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_backfill_status ON perm_backfill_plan(status);
GRANT SELECT ON perm_backfill_plan TO authenticated;

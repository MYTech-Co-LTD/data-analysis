-- 180_perm_freeze_snapshot.sql
-- W4 / spec W4 退出判据 M4/B3：shadow 对账基线 = U2 时点冻结的 legacy（data_permissions 派生）快照，
-- 非当前镜像（同源恒等 diff=0 自证门禁，B3 封口）。
-- 快照不可变：行级触发器禁 UPDATE/DELETE（写关闭前置）；冻结哨兵 = 表级标记，对账读基线前必查。
--
-- ⚠️ 与 plan L1459-1522 基线的唯一偏离（task14 report 有完整证据）：
-- plan 原文 `to_jsonb(coalesce(brands, '[]'::text[]))` 对真实 schema 不成立——
--   ① `'[]'::text[]` 本身非法（PG 数组字面量是 '{}'，实测 ERROR malformed array literal）；
--   ② data_permissions 的 brands/categories/branch_nums 实为 JSONB 列（迁移167 及本计划 §①/L2437 同款口径）。
-- 故按 167 既有惯例改为 `coalesce(x, '[]'::jsonb)`（语义等价：NULL→'[]' 归一，JSONB 原样拷贝，
-- 且与 W6 恢复路径「快照 JSONB 直插 data_permissions JSONB」兼容）。其余逐字。
--
-- ⚠️ 偏离②（同 report）：plan 原文 unfreeze_perms 用 `DELETE FROM perm_freeze_snapshot` 清快照，
-- 但行级 BEFORE DELETE 触发器对函数自身同样生效 → 实测 unfreeze 恒报 immutable 且整体回滚（哨兵都删不掉），
-- 与需求「删哨兵+清快照」矛盾。改为 TRUNCATE：行级触发器不对 TRUNCATE 触发（PG 语义），
-- 且 TRUNCATE 是独立权限、authenticated 未获授（实测 grants 仅 S/I/U/D）——经 SECURITY DEFINER
-- 的 unfreeze 可清，PostgREST 面不可绕，不可变约束对普通 DML 依然全封死。

CREATE TABLE IF NOT EXISTS perm_freeze_snapshot (
  id           BIGSERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,               -- 'user'|'role'|'dept'（167 三类行）
  subject_id   TEXT NOT NULL,
  brands       JSONB NOT NULL DEFAULT '[]',
  categories   JSONB NOT NULL DEFAULT '[]',
  branch_nums  JSONB NOT NULL DEFAULT '[]',
  can_see_cost BOOLEAN NOT NULL DEFAULT FALSE,
  frozen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE IF NOT EXISTS perm_freeze_sentinel (
  key       TEXT PRIMARY KEY,               -- 'data_permissions_frozen'
  frozen_at TIMESTAMPTZ NOT NULL
);

-- 冻结 RPC：U2 发布窗内人工触发（一次性动作；重复调用 = no-op 幂等）
CREATE OR REPLACE FUNCTION freeze_perms()
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE t TIMESTAMPTZ := now() AT TIME ZONE 'UTC';
BEGIN
  INSERT INTO perm_freeze_sentinel(key, frozen_at) VALUES ('data_permissions_frozen', t)
  ON CONFLICT (key) DO NOTHING;                          -- 已冻结 = no-op（防误触重冻覆盖基线）
  INSERT INTO perm_freeze_snapshot(subject_type, subject_id, brands, categories, branch_nums, can_see_cost)
  SELECT subject_type, subject_id,
         coalesce(brands, '[]'::jsonb), coalesce(categories, '[]'::jsonb),
         coalesce(branch_nums, '[]'::jsonb), coalesce(can_see_cost, false)
  FROM data_permissions
  ON CONFLICT (subject_type, subject_id) DO NOTHING;     -- 重跑只补缺（幂等）
  RETURN (SELECT frozen_at FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen');
END; $$;

-- 演练解冻（仅回滚演练用；生产禁调——写审计）
CREATE OR REPLACE FUNCTION unfreeze_perms()
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen') THEN
    RETURN 0;
  END IF;
  DELETE FROM perm_freeze_sentinel WHERE key = 'data_permissions_frozen';
  TRUNCATE perm_freeze_snapshot;  -- 不用 DELETE：行级禁删触发器对本函数同样生效（偏离②，见文件头）
  RETURN 1;
END; $$;

-- 快照不可变：禁 UPDATE/DELETE（INSERT 仅 freeze_perms 路径合法；触发器兜底）
CREATE OR REPLACE FUNCTION perm_snapshot_immutable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'perm_freeze_snapshot is immutable (frozen baseline, B3)';
END; $$;
DROP TRIGGER IF EXISTS trg_snapshot_no_update ON perm_freeze_snapshot;
CREATE TRIGGER trg_snapshot_no_update BEFORE UPDATE OR DELETE ON perm_freeze_snapshot
  FOR EACH ROW EXECUTE FUNCTION perm_snapshot_immutable();

GRANT SELECT ON perm_freeze_snapshot, perm_freeze_sentinel TO authenticated;
GRANT EXECUTE ON FUNCTION freeze_perms, unfreeze_perms TO authenticated;  -- 调用面由 requireAdmin 管（UI 不暴露 unfreeze）

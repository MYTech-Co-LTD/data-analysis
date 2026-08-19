-- 199_scope_packs_dim_truth.sql
-- maps_branch_group 真相源切换（2026-08-19 用户裁定）：
--   能力页（dim_branch 区域体系）= 唯一真相源；maps 是它的投影，能力页有的区域包必须存在。
--   背景：2026-08-17 rebuild 按企微部门名驱动，dim_branch 4 个区域（其他门店/其余门店1/广西大区/
--   贵州宣威大区，共 140 家店）在企微无同名部门 → JOIN 不上 → 键宇宙缺失 → Casdoor 配
--   范围|其他门店 登录 fail-close 503（unknown scope key）。
--   职能全店包（30 个部门 × 388 行）：data-analysis 职能概念已废弃（权限 = Casdoor 角色 ×
--   数据范围×门禁），且审计确认 Casdoor permission 无一引用 → 删除。
-- 形态：group_id = dim_branch 区域名（first_level_region ∪ second_level_region 非空值），
--   group_type='region'、source='sync'（由本迁移与 web/lib/sync/scope-packs.ts 同步逻辑共同维护，
--   语义相同；登录解析 resolveScopeKeys 不看 group_type，仅按 group_id 展开）。
-- 幂等：整表重建（DELETE + INSERT），可重复执行；结果与同步逻辑收敛一致。
BEGIN;

-- source 枚举扩充：178 仅允许 ('auto','manual')，投影行统一标 'sync'
ALTER TABLE maps_branch_group DROP CONSTRAINT IF EXISTS maps_branch_group_source_check;
ALTER TABLE maps_branch_group ADD CONSTRAINT maps_branch_group_source_check
  CHECK (source IN ('auto','manual','sync'));

DELETE FROM maps_branch_group;

-- 区域包：first_level_region（战区层，含"其他门店"等非企微区域）
INSERT INTO maps_branch_group (group_id, group_name, group_type, branch_number, is_active, source)
SELECT DISTINCT b.first_level_region, b.first_level_region, 'region', b.branch_number, true, 'sync'
FROM dim_branch b
WHERE b.is_active AND b.branch_number IS NOT NULL
  AND b.first_level_region IS NOT NULL AND b.first_level_region <> ''
ON CONFLICT (group_id, branch_number) DO NOTHING;

-- 区域包：second_level_region（二级区域层；''=未分区不建包）
INSERT INTO maps_branch_group (group_id, group_name, group_type, branch_number, is_active, source)
SELECT b.second_level_region, b.second_level_region, 'region', b.branch_number, true, 'sync'
FROM dim_branch b
WHERE b.is_active AND b.branch_number IS NOT NULL
  AND b.second_level_region IS NOT NULL AND b.second_level_region <> ''
ON CONFLICT (group_id, branch_number) DO NOTHING;

-- 验证断言（防重复/漂移）：区域包数 = dim 区域值数；无 source<>'sync' 残留行
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM maps_branch_group WHERE source <> 'sync') THEN
    RAISE EXCEPTION 'Migration 199: maps_branch_group 存在非 sync 行（manual/auto 残留）——应全量重建';
  END IF;
  RAISE NOTICE 'Migration 199: maps_branch_group 已切换为 dim_branch 区域真相源（% 个区域包）',
    (SELECT count(DISTINCT group_id) FROM maps_branch_group);
END $$;

COMMIT;

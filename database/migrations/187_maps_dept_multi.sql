-- 187_maps_dept_multi.sql
-- maps_branch_group 约束改组→门店多对多（2026-08-17 组树迁移企微部门树，用户裁定「组织架构严格按企微」）。
-- 背景：178 原设计 1:1（UNIQUE branch_number + UNIQUE group_id——一组=一门店）。部门形态下
--   一个部门组映射 N 门店（战区→辖区全店、职能部门→全店 388），且同一门店出现在多个部门组
--   （30 个非战区链部门均含全店）→ 双唯一约束必须放宽为 (group_id, branch_number) 复合唯一。
-- 幂等：DROP IF EXISTS ×2 + DO 块条件 ADD。
BEGIN;

ALTER TABLE maps_branch_group DROP CONSTRAINT IF EXISTS fk_maps_branch;
ALTER TABLE maps_branch_group DROP CONSTRAINT IF EXISTS fk_maps_group;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_maps_group_branch') THEN
    ALTER TABLE maps_branch_group ADD CONSTRAINT uq_maps_group_branch UNIQUE (group_id, branch_number);
  END IF;
END $$;

DO $$ BEGIN RAISE NOTICE 'Migration 187: maps_branch_group 约束放宽为 (group_id, branch_number) 复合唯一——部门组多对多映射'; END $$;

COMMIT;

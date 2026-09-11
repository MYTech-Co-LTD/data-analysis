-- 212_registry_fact_scope.sql
-- spec: docs/superpowers/specs/2026-09-11-replenishment-detail-query-onboarding-design.md
-- 数据注册中心：事实数据集的「门店复合键表达式」声明列。
-- 用途：agent-query 网关据此对 kind=fact 的数据集通用构建权限视图（行级裁剪）。
-- 为空 = 不可通用构建 → 网关不建视图且不进 SQL 白名单（fail-close）。
-- 幂等：ADD COLUMN IF NOT EXISTS。
BEGIN;

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS scope_key_expr TEXT;

COMMENT ON COLUMN datasets.scope_key_expr IS
  '事实数据集的门店复合键 SQL 表达式（对本数据集注册列求值，产出归一形态 sbc-branch_num，用于行级权限裁剪）；为空=不可通用构建→ deny';

-- 源列名 → 视图列名映射（2026-09-11 加）：外部管线的列名不必与平台口径名一致。
-- 例：本行 name='system_book_code' 而 parquet 里的真实列叫 'company_id'，则 source_name='company_id'，
-- 视图投影为 "company_id" AS "system_book_code"。为空表示同名。
ALTER TABLE dataset_columns ADD COLUMN IF NOT EXISTS source_name TEXT;

COMMENT ON COLUMN dataset_columns.source_name IS
  '源 parquet 列名 → 视图列名（本行 name）的映射；为空=与 name 同名。用于外部管线列名与平台口径名不一致时，避免要求对方改名';

COMMIT;

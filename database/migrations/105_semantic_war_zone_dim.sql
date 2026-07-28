-- 105_semantic_war_zone_dim.sql
-- 语义层同步：注册 war_zone 维度（考核范围声明在语义层，来源 dim_war_zone）；
--   branch 维度 business_rule 标注考核范围=dim_war_zone.is_assessed。
-- 幂等：ON CONFLICT DO UPDATE；部署后 restart postgrest。

-- 注册战区维度
INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, source_fact_table, business_rule, is_assessed_filter) VALUES
  ('war_zone','战区','战区维度：考核范围(is_assessed)单一事实源；is_assessed_war_zone() 读 dim_war_zone','static','dim_war_zone','war_zone',NULL,'is_assessed=true 的战区参与考核。改考核范围改 dim_war_zone 数据，不动代码',false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, join_table=EXCLUDED.join_table,
  join_key=EXCLUDED.join_key, business_rule=EXCLUDED.business_rule;

-- branch 维度 business_rule 标注考核来源
UPDATE dimensions
SET business_rule='门店组织维度（战区/小区/门店三级）。考核范围由 dim_war_zone.is_assessed 决定（is_assessed_war_zone 读此表）'
WHERE dim_code='branch';

DO $$ BEGIN RAISE NOTICE 'Migration 105: 语义层注册 war_zone 维度 + branch business_rule 标注考核来源'; END $$;

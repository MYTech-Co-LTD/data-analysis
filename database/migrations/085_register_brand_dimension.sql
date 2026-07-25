-- 085_register_brand_dimension.sql
-- brand 独立维度（与 branch 正交）：战区跨品牌合并，品牌不该混进 branch 层级（brand→region 父子矛盾）
-- branch 维度保持 3层（region→sub_region→store，跨品牌战区/小区/门店，总部视角）
-- brand 单独维度（3120熊喵/64188品品），报表可按品牌切片或与 branch 交叉
-- dim_brand 已有（084），这里注册到 dimensions/dimension_levels
-- 幂等：ON CONFLICT；部署后重启 postgrest

INSERT INTO dimensions (dim_code, name, description, source_type, join_table, join_key, is_assessed_filter) VALUES
  ('brand','品牌','品牌维度（独立，3120熊喵鲜生/64188品品甜；与 branch 正交——branch 战区跨品牌合并，brand 不混进 branch 层级；报表可按品牌切片或交叉）',
   'static','dim_brand','system_book_code', false)
ON CONFLICT (dim_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, source_type=EXCLUDED.source_type,
  join_table=EXCLUDED.join_table, join_key=EXCLUDED.join_key, is_assessed_filter=EXCLUDED.is_assessed_filter;

INSERT INTO dimension_levels (dim_code, level_code, level_name, depth, key_column, name_column, parent_level, rollup_strategy) VALUES
  ('brand','brand','品牌',0,'system_book_code','brand_name',NULL,'sum')
ON CONFLICT (dim_code, level_code) DO UPDATE SET
  level_name=EXCLUDED.level_name, depth=EXCLUDED.depth, key_column=EXCLUDED.key_column,
  name_column=EXCLUDED.name_column, parent_level=EXCLUDED.parent_level, rollup_strategy=EXCLUDED.rollup_strategy;

DO $$ BEGIN RAISE NOTICE 'Migration 085: brand 独立维度注册（与 branch 正交，战区跨品牌合并不混入品牌层级）'; END $$;

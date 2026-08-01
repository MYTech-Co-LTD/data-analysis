-- 076_metric_registry.sql
-- 语义层指标注册表：声明式指标定义（base 事实表聚合 / derived 基于他指标运算）
-- 替代 metric_definitions 的 NULL 指针问题（outbound 口径不再散落视图 SQL）
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；保留旧 metric_definitions 兼容
-- 部署后需重启 postgrest: docker compose restart postgrest

CREATE TABLE IF NOT EXISTS metric_registry (
  metric_code      TEXT PRIMARY KEY,
  name             TEXT NOT NULL,           -- 中文显示名
  description      TEXT,                    -- 业务口径说明（中文）
  business_formula TEXT,                    -- 中文自然语言公式
  measure_type     TEXT NOT NULL CHECK (measure_type IN ('base','derived')),
  fact_table       TEXT,                    -- base: datasets 注册名（retail_detail 等）；derived: NULL
  value_column     TEXT,                    -- base: 聚合列；derived: NULL
  agg              TEXT CHECK (agg IS NULL OR agg IN ('SUM','COUNT_DISTINCT','AVG','MAX','MIN')),
  depends_on       JSONB DEFAULT '[]'::jsonb, -- derived: 依赖的 metric_code 数组；base: []
  additive         BOOLEAN NOT NULL,        -- true: 可按维度 SUM；false: 比率须重算
  cost_sensitive   BOOLEAN DEFAULT false,   -- 是否需 can_see_cost 脱敏
  unit             TEXT,                    -- 元 / % / 件
  data_ready       BOOLEAN DEFAULT true,
  enabled          BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT chk_measure_base CHECK (
    (measure_type <> 'base') OR (fact_table IS NOT NULL AND value_column IS NOT NULL AND agg IS NOT NULL)
  ),
  CONSTRAINT chk_measure_derived CHECK (
    (measure_type <> 'derived') OR (depends_on::text <> '[]')
  )
);

COMMENT ON TABLE metric_registry IS '语义层指标注册表：base=事实表聚合，derived=基于他指标运算。单一口径来源';

INSERT INTO metric_registry (metric_code, name, description, business_formula, measure_type, fact_table, value_column, agg, depends_on, additive, cost_sensitive, unit) VALUES
  ('sale_amount','销售金额','所有门店零售金额合计，不含批发','各门店 sale_money 之和','base','retail_detail','sale_money','SUM','[]'::jsonb,true,false,'元'),
  ('sale_profit','销售毛利','零售毛利合计','各门店 profit 之和（成本敏感）','base','retail_detail','profit','SUM','[]'::jsonb,true,true,'元'),
  ('delivery_amount','出库金额','配送调出金额合计','out_money 之和','base','delivery_detail','out_money','SUM','[]'::jsonb,true,false,'元'),
  ('delivery_profit','出库毛利','配送毛利合计','profit_money 之和（成本敏感）','base','delivery_detail','profit_money','SUM','[]'::jsonb,true,true,'元'),
  ('wholesale_amount','批发金额','批发销售金额合计','wholesale_money 之和','base','wholesale_detail','wholesale_money','SUM','[]'::jsonb,true,false,'元'),
  ('wholesale_profit','批发毛利','批发毛利合计','wholesale_profit 之和（成本敏感）','base','wholesale_detail','wholesale_profit','SUM','[]'::jsonb,true,true,'元'),
  ('outbound_amount','总出库金额','配送+批发出库金额','delivery_amount + wholesale_amount','derived',NULL,NULL,NULL,'["delivery_amount","wholesale_amount"]'::jsonb,true,false,'元'),
  ('outbound_profit','总出库毛利','配送+批发出库毛利','delivery_profit + wholesale_profit','derived',NULL,NULL,NULL,'["delivery_profit","wholesale_profit"]'::jsonb,true,true,'元'),
  ('margin','毛利率','毛利占金额比','profit / amount（不可直接 SUM，须重算）','derived',NULL,NULL,NULL,'["sale_profit","sale_amount"]'::jsonb,false,true,'%')
ON CONFLICT (metric_code) DO UPDATE SET
  name=EXCLUDED.name, description=EXCLUDED.description, business_formula =EXCLUDED.business_formula,
  measure_type=EXCLUDED.measure_type, fact_table=EXCLUDED.fact_table, value_column=EXCLUDED.value_column,
  agg=EXCLUDED.agg, depends_on=EXCLUDED.depends_on,
  additive=EXCLUDED.additive, cost_sensitive=EXCLUDED.cost_sensitive, unit=EXCLUDED.unit;

GRANT SELECT ON metric_registry TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 076 completed: metric_registry + 9 metrics'; END $$;

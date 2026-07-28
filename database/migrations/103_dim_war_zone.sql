-- 103_dim_war_zone.sql
-- 战区维度（考核范围单一事实源）：is_assessed=true 的战区参与考核。
-- 取代 064 is_assessed_war_zone() 的硬编码白名单——改考核范围改本表数据，不动代码。
-- 幂等：CREATE TABLE IF NOT EXISTS + ON CONFLICT；部署后 restart postgrest
CREATE TABLE IF NOT EXISTS dim_war_zone (
  war_zone     TEXT PRIMARY KEY,
  is_assessed  BOOLEAN NOT NULL DEFAULT false,
  display_name TEXT,
  updated_at   TIMESTAMP DEFAULT NOW()
);
COMMENT ON TABLE dim_war_zone IS '战区维度：考核范围(is_assessed)单一事实源。is_assessed_war_zone() 读此表';

INSERT INTO dim_war_zone (war_zone, is_assessed, display_name) VALUES
  ('东部战区', true, '东部战区'),
  ('南部战区', true, '南部战区'),
  ('西部战区', true, '西部战区'),
  ('中部战区', true, '中部战区'),
  ('其余门店1', false, '其余门店1'),
  ('其他门店', false, '其他门店'),
  ('贵州宣威大区', false, '贵州宣威大区'),
  ('广西大区', false, '广西大区')
ON CONFLICT (war_zone) DO UPDATE SET
  is_assessed=EXCLUDED.is_assessed, display_name=EXCLUDED.display_name, updated_at=NOW();

GRANT SELECT ON dim_war_zone TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 103: dim_war_zone（考核范围单一事实源，8 战区，4 考核）'; END $$;

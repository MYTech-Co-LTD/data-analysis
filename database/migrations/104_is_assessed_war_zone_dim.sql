-- 104_is_assessed_war_zone_dim.sql
-- is_assessed_war_zone() 重定义：从硬编码白名单 → 查 dim_war_zone 维表。
-- 签名不变（p TEXT → BOOLEAN），所有调用点(064/065/066/070/081/091/096/102...)零改动自动数据驱动。
-- IMMUTABLE→STABLE（现在读表；无索引/物化引用，安全）。部署后 restart postgrest。
CREATE OR REPLACE FUNCTION is_assessed_war_zone(p TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$ SELECT COALESCE((SELECT is_assessed FROM dim_war_zone WHERE war_zone=p), false) $$;

GRANT EXECUTE ON FUNCTION is_assessed_war_zone(TEXT) TO authenticated, anon;

DO $$ BEGIN RAISE NOTICE 'Migration 104: is_assessed_war_zone 改查 dim_war_zone（数据驱动，签名不变）'; END $$;

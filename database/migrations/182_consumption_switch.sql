-- 182_consumption_switch.sql
-- W4 消费侧切（spec §5.7）：列掩码判定函数统一读 fields 段（114 扁平后 request.jwt.claims.fields = jsonb GUC）。
-- 无 fields 段 → 全掩（安全方向，H7 契约快照断言）；legacy can_see_cost 顶层 key 双氧保留（B6）——
-- can_cost_visible() 形状鉴别：fields 段存在读 fields.cost；缺失回退 can_see_cost（旧令牌）。
CREATE OR REPLACE FUNCTION can_cost_visible()
RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
DECLARE v_fields JSONB;
BEGIN
  v_fields := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb -> 'fields';
  IF v_fields IS NOT NULL THEN
    RETURN coalesce((v_fields->>'cost')::boolean, false);   -- 段存在缺 key = false（全掩方向）
  END IF;
  RETURN coalesce((NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'can_see_cost')::boolean, false);
END; $$;
GRANT EXECUTE ON FUNCTION can_cost_visible TO anon, authenticated;

COMMENT ON FUNCTION can_cost_visible IS 'W4 消费侧切列掩码判定（形状鉴别，同 179 模式）：claims.fields 段存在→读 fields.cost（缺 key=false 全掩）；缺失→回退 legacy 顶层 can_see_cost（旧令牌，B6 双氧，Task 20 sunset 删）';

DO $$ BEGIN RAISE NOTICE 'Migration 182: can_cost_visible() 形状鉴别（fields.cost 主读 + can_see_cost 回退）'; END $$;

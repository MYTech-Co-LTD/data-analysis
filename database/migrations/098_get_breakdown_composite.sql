-- 098_get_breakdown_composite.sql
-- get_breakdown 重建：storeRows 带 system_book_code/branch_number/brand_name；
--   metrics 子查询改复合键(修共享branch_num错配)；ORDER BY 含 system_book_code
-- 幂等：CREATE OR REPLACE FUNCTION；部署后 restart postgrest
CREATE OR REPLACE FUNCTION get_breakdown(p_parent_id BIGINT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_sbc TEXT; v_out JSONB;
BEGIN
  SELECT system_book_code INTO v_sbc FROM targets WHERE id=p_parent_id;
  SELECT jsonb_build_object(
    'warZoneRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='war_zone'),'[]'::jsonb),
    'regionRows', COALESCE((SELECT jsonb_agg(jsonb_build_object('war_zone',t.war_zone,'region_l2',t.region_l2,'metrics',
      COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value) FROM target_metric_values mv WHERE mv.target_id=t.id),'{}'::jsonb))
      ORDER BY t.war_zone,t.region_l2) FROM targets t WHERE t.parent_target_id=p_parent_id AND t.breakdown_level='region_l2'),'[]'::jsonb),
    'storeRows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'system_book_code',b.system_book_code,
        'branch_number',b.branch_number,
        'brand_name',br.brand_name,
        'branch_num',b.branch_num,'branch_name',b.branch_name,
        'war_zone',b.first_level_region,'region_l2',b.second_level_region,'group',e.custom_group,
        'metrics',COALESCE((SELECT jsonb_object_agg(mv.metric_code,mv.target_value)
          FROM target_metric_values mv JOIN targets s ON s.id=mv.target_id
          WHERE s.parent_target_id=p_parent_id AND s.breakdown_level='store'
            AND s.system_book_code=b.system_book_code AND s.branch_num=b.branch_num),'{}'::jsonb))
      ORDER BY b.system_book_code, b.first_level_region, b.second_level_region, b.branch_num)
      FROM dim_branch b
      LEFT JOIN dim_branch_ext e ON e.system_book_code=b.system_book_code AND e.branch_num=b.branch_num
      LEFT JOIN dim_brand br ON br.system_book_code=b.system_book_code
      WHERE (v_sbc='ALL' OR b.system_book_code=v_sbc) AND b.is_active=true AND b.branch_num<>'99'),'[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END $$;
GRANT EXECUTE ON FUNCTION get_breakdown(BIGINT) TO authenticated, anon;
DO $$ BEGIN RAISE NOTICE 'Migration 098: get_breakdown storeRows 带 sbc/branch_number/brand'; END $$;

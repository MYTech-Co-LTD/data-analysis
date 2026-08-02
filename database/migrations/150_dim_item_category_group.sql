-- 150_dim_item_category_group.sql
-- dim_item 加 category_group STORED 生成列：商品→粗类映射（水果/标品/耗材/其他）。
-- 复用 093_unify_category_group 的 CASE 口径，把映射统一到 dim 源头（delivery/wholesale 日后可复用）。
-- 用途：品类看板下钻——report_item_breakdown_gen 携带 category_group，按粗类筛商品明细。
-- 幂等：ADD COLUMN IF NOT EXISTS，重跑跳过。表达式全 immutable（CASE+split_part+coalesce），PG15 支持。
-- 采集安全：dim_item 经 PostgREST upsert 写（web/lib/collect-items.ts），payload 不含 category_group，不冲突。
ALTER TABLE dim_item
ADD COLUMN IF NOT EXISTS category_group TEXT
GENERATED ALWAYS AS (
  CASE split_part(COALESCE(category_path,''),'->',1)
    WHEN '生鲜' THEN '水果'
    WHEN '标品' THEN '标品' WHEN '废弃档案' THEN '标品' WHEN '广西柳州' THEN '标品'
    WHEN '包装耗材' THEN '耗材' WHEN '运费/仓储用耗材' THEN '耗材'
    ELSE '其他'
  END
) STORED;
DO $$ BEGIN RAISE NOTICE 'Migration 150: dim_item.category_group 生成列（粗类，复用 093 CASE）'; END $$;

-- database/migrations/188_token_blacklist_offboard.sql
-- 离职四 sink①（web API 面即时收权，2026-08-17）：
--   thin-sync disable 动作成功后按 user_id（=wecom_id=sub）写 token_blacklist
--   （token_hash 列存哨兵值 'sub:<wecom_id>'，expires_at=+7d JWT 窗口），
--   middleware 以 or=(token_hash.eq.X, user_id.eq.sub) 查询——旧 7 天 JWT 即刻拒。
--   is_active 软校验（org_users.is_active=false 即拒，不等 thin-sync）为第二道兑底。
-- 本迁移仅补 user_id 查询索引（007 建表时已有 user_id 列但无索引）+ 语义注释。
-- 幂等：IF NOT EXISTS。

CREATE INDEX IF NOT EXISTS idx_token_blacklist_user ON token_blacklist(user_id);

COMMENT ON COLUMN token_blacklist.user_id IS '按 sub 拉黑维度：thin-sync 离职 disable 成功后写入，middleware 按此列查（离职四 sink①，188）';
COMMENT ON COLUMN token_blacklist.reason IS 'logout | revoked | expired | offboard（离职拉黑，188）';

-- 验证断言（重复执行不报错）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_token_blacklist_user') THEN
    RAISE EXCEPTION '188 verification failed: idx_token_blacklist_user missing';
  END IF;
END $$;

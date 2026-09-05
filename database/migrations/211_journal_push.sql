-- 211_journal_push.sql
-- 日报（企微「汇报」应用）推送流水线的状态存储 + 战区当月销售视图。
-- 需求：员工提交「区域经理复盘日报」→ 轮询拉取 → 补充系统真实销售/达标率 → 群机器人推送。
-- 幂等：IF NOT EXISTS / CREATE OR REPLACE。

-- 已处理的汇报记录单号（防重复推送）
CREATE TABLE IF NOT EXISTS journal_push_seen (
  journaluuid  text PRIMARY KEY,
  submitter    text,
  war_zone     text,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- 轮询水位（key='record_watermark'，value=unix 秒）
CREATE TABLE IF NOT EXISTS journal_push_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO journal_push_state (key, value)
VALUES ('record_watermark', extract(epoch from now())::text)
ON CONFLICT (key) DO NOTHING;

-- 战区当月累计销售额（真实数，日报核对用）
-- 数据源：report_daily_sales × branch_admin_v（含 war_zone 维度，见 205/208 号迁移链）
CREATE OR REPLACE VIEW journal_war_zone_month_sales AS
SELECT b.war_zone                                            AS war_zone,
       date_trunc('month', CURRENT_DATE)::date               AS month_start,
       COALESCE(SUM(s.total_sale), 0)::numeric(14, 2)        AS month_sales,
       COUNT(DISTINCT s.branch_num)                          AS store_count,
       MAX(s.biz_date)                                       AS latest_biz_date
FROM report_daily_sales s
JOIN branch_admin_v b
  ON s.branch_num = b.branch_num
 AND s.system_book_code = b.system_book_code
WHERE s.biz_date >= date_trunc('month', CURRENT_DATE)::date
GROUP BY b.war_zone;

-- 验证断言
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_push_seen') THEN
    RAISE EXCEPTION 'journal_push_seen missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_push_state') THEN
    RAISE EXCEPTION 'journal_push_state missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.views WHERE table_name = 'journal_war_zone_month_sales') THEN
    RAISE EXCEPTION 'journal_war_zone_month_sales missing';
  END IF;
END $$;

-- PostgREST（anon）访问授权：function 经 PostgREST 读写水位/已处理表、读视图
GRANT SELECT, INSERT ON journal_push_seen TO anon, authenticated;
GRANT SELECT, UPDATE ON journal_push_state TO anon, authenticated;
GRANT SELECT ON journal_war_zone_month_sales TO anon, authenticated;

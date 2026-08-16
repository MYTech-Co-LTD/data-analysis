-- 178_maps_branch_group.sql
-- W2 / spec §5.3：门店↔Group 自省映射 + groups 投影列（F9）。
-- 依赖：dim_branch（既有）。门店键铁律：branch_number 全局唯一（sbc-branch_num 派生），禁裸 branch_num。

CREATE TABLE IF NOT EXISTS maps_branch_group (
  id           BIGSERIAL PRIMARY KEY,
  branch_number TEXT NOT NULL,               -- dim_branch.branch_number（全局唯一派生键）
  group_id     TEXT NOT NULL,                -- Casdoor group id
  group_name   TEXT NOT NULL,                -- 展示用（判定用 group_id，改名不断链）
  group_type   TEXT NOT NULL DEFAULT 'store' -- 'store'|'region'|'dept'（三态，H13）
                CHECK (group_type IN ('store','region','dept')),
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_maps_branch UNIQUE (branch_number),
  CONSTRAINT fk_maps_group   UNIQUE (group_id),
  CONSTRAINT uq_maps_no_sep  CHECK (group_name NOT LIKE '%/%')  -- 禁分隔符（组路径精确匹配前提）
);
CREATE INDEX IF NOT EXISTS idx_maps_branch_group_type ON maps_branch_group(group_type) WHERE is_active;

-- groups 投影（F9）：无会话路径（run_push/agent-query）读门店行的唯一入口
ALTER TABLE org_users ADD COLUMN IF NOT EXISTS groups JSONB NOT NULL DEFAULT '[]'::jsonb;

-- 审计归因（H15）：同步器写入带「自动化」标记
ALTER TABLE maps_branch_group ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'auto'
  CHECK (source IN ('auto','manual'));

GRANT SELECT ON maps_branch_group TO anon, authenticated;
GRANT SELECT, UPDATE(groups) ON org_users TO authenticated;

-- ---- Task 10：影子对账 7 天门禁历史表（H10/M4，W2 退出判据）----
-- 每日 03:37 cron（web/app/api/admin/cron/reconcile-groups）UPSERT 当日行；
-- gate7days 查最近 7 行：whitelist_outside_diff=0 且 red_count=0 连续 7 天才放行 W3。
-- detail 留 per-user diff 全量（red/minor/whitelistHits）+ 白名单审批快照（人工审批=编辑 detail.whitelist，审计留痕）。
CREATE TABLE IF NOT EXISTS group_reconcile_history (
  date                   DATE PRIMARY KEY,                -- 北京时区自然日（cron 侧格式化）
  whitelist_outside_diff INT  NOT NULL,                   -- 白名单外 diff 条数（Σ missing+extra 未被白名单吸收）
  red_count              INT  NOT NULL,                   -- E 级红用户数
  detail                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_group_reconcile_history_date ON group_reconcile_history(date);

GRANT SELECT ON group_reconcile_history TO anon, authenticated;

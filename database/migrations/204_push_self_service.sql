-- 204_push_self_service.sql
-- 推送自助配置（spec 2026-08-20-push-self-service-config）：
--   1) push_message_presets 演进为模板库（加 name/updated_by，workflow_id 退役为可选关联）
--   2) push_variables 加 description（通俗口径说明）+ 7 变量定稿（UI 只显 name+description）
--   3) push_configs 推送任务表（替代旧 scheduled_reports 角色，旧表退役不迁移）
-- 幂等：IF NOT EXISTS / ON CONFLICT DO UPDATE。
BEGIN;

-- 1) 模板库演进
ALTER TABLE push_message_presets ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE push_message_presets ADD COLUMN IF NOT EXISTS updated_by TEXT;
COMMENT ON COLUMN push_message_presets.name IS '模板名（管理页显示；为空时回退 preset_id）';

-- 2) 变量通俗化 + 补齐
ALTER TABLE push_variables ADD COLUMN IF NOT EXISTS description TEXT;

INSERT INTO push_variables (var_code, name, description, metric_code, scope_dim, unit, enabled) VALUES
  ('sale_amount',     '销售额',     '当前进行中目标的销售实际值，按收件人权限范围统计', 'sale_amount',     'total', '元', true),
  ('achievement_rate','销售达成率', '销售实际÷目标（当前进行中目标），按收件人权限范围',  'sale_rate',       'total', '%',  true),
  ('delivery_amount', '配送额',     '当前进行中目标的配送实际值',                        'delivery_amount', 'total', '元', true),
  ('delivery_rate',   '配送达成率', '配送实际÷目标（当前进行中目标）',                    'delivery_amount', 'total', '%',  true),
  ('outbound_amt',    '出库金额',   '配送+批发出库合计金额',                              'outbound_amount', 'total', '元', true),
  ('outbound_profit', '出库毛利',   '配送+批发出库合计毛利',                              'outbound_profit', 'total', '元', true),
  ('detail_url',      '门店明细入口','点开直达收件人有权限的门店明细报表',                 NULL,              'total', NULL, true)
ON CONFLICT (var_code) DO UPDATE SET
  name = EXCLUDED.name, description = EXCLUDED.description,
  metric_code = EXCLUDED.metric_code, unit = EXCLUDED.unit, enabled = EXCLUDED.enabled;

-- ⚠️ delivery_rate 的 metric_code 用 delivery_amount 查视图 delivery 行的 achievement_rate（rate 类按视图列取，见 T2）
-- ⚠️ outbound_amt 行 metric_code 用 metric_registry 真名 outbound_amount（非视图行名 outbound_amt）：
--    push_variables.metric_code 有 FK → metric_registry(metric_code)（迁移 173），生产 registry 无 outbound_amt
--    （只有 outbound_amount，2026-08-20 生产核实）。引擎 METRIC_TO_VIEW（web/lib/push/index.ts）当前键为
--    outbound_amt → 视图 outbound_amt；T2 须把键改为/加上 outbound_amount → 'outbound_amt' 才能渲染此变量，
--    否则 resolveNumericValue 返回 null（该变量不渲染，与今日行为一致，非回归）。

-- 3) 推送任务表
CREATE TABLE IF NOT EXISTS push_configs (
  config_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  cron_spec            JSONB NOT NULL,        -- {kind: daily|weekly|monthly, time: "HH:mm", weekday?: 1-7(周一=1), day?: 1-31}
  enabled              BOOLEAN NOT NULL DEFAULT true,
  selector_json        JSONB NOT NULL,        -- {kind: dept|person, ids: [...]}
  target_mode          TEXT NOT NULL DEFAULT 'follow' CHECK (target_mode IN ('follow','fixed')),
  target_id            BIGINT,                -- fixed 模式必填 → targets.id
  preset_id            TEXT NOT NULL REFERENCES push_message_presets(preset_id),
  owner_wecom_id       TEXT NOT NULL,
  last_run_date        DATE,
  last_run_txn_id      TEXT,
  last_guard_notice_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_configs_enabled ON push_configs(enabled) WHERE enabled;
GRANT SELECT, INSERT, UPDATE ON push_configs TO anon, authenticated;

-- ⚠️ C1（终审 Critical）：push_configs.preset_id 缺 FK → PostgREST 无法建 has_many 关系，
--    `push_message_presets?select=*,push_configs(count)`（模板列表嵌入计数）恒 400/502。
--    CREATE TABLE 已内联 REFERENCES（首部署一次建好）；此处幂等补丁兜底「本地/生产已建表」
--    （CREATE TABLE IF NOT EXISTS 跳过约束时）。DROP+ADD 为数据无关操作（UI 下拉保证 preset 必存在）。
ALTER TABLE push_configs DROP CONSTRAINT IF EXISTS push_configs_preset_id_fkey;
ALTER TABLE push_configs ADD CONSTRAINT push_configs_preset_id_fkey
  FOREIGN KEY (preset_id) REFERENCES push_message_presets(preset_id);

-- 旧 scheduled_reports 退役标记（生产 0 行，保留表不迁移）
COMMENT ON TABLE scheduled_reports IS 'DEPRECATED 2026-08-20：推送任务改 push_configs（spec 2026-08-20-push-self-service-config）';

COMMIT;

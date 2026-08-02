-- 139_target_auto_close_flag.sql
-- 目标自动定格开关：targets.auto_close（默认 true，向后兼容）
-- 背景：scheduler 每天 05:10 自动调 close_target 固化到期目标（registerTargetCloseJob）。
--   7月目标数据未校准，用户决策「待数据校准后再定格」→ 需要按目标豁免自动关闭。
-- 用法：auto_close=false 的目标不被 get_due_targets 选中（手动定格仍可用 close_target）。

ALTER TABLE targets ADD COLUMN IF NOT EXISTS auto_close BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN targets.auto_close IS '到期后是否允许定时任务自动 close_target 定格。false=豁免（如数据校准中的历史目标），手动定格不受影响';

-- get_due_targets 增加 auto_close 过滤
CREATE OR REPLACE FUNCTION get_due_targets() RETURNS TABLE(id BIGINT)
LANGUAGE sql SECURITY DEFINER AS $$
  SELECT t.id FROM targets t
  WHERE t.status = 'active'
    AND t.target_level = 'total'
    AND t.end_date < current_date
    AND t.auto_close
$$;

GRANT EXECUTE ON FUNCTION get_due_targets() TO authenticated;

-- 7月目标：数据校准中，豁免自动定格（校准完成后改回 true 或手动 close_target）
UPDATE targets SET auto_close = false WHERE id = 22;

DO $$ BEGIN RAISE NOTICE 'Migration 139: targets.auto_close 开关上线，7月目标(22)已豁免自动定格'; END $$;
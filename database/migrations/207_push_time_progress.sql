-- 207_push_time_progress.sql
-- 摘要加时间进度 + keyname 缩短防换行（2026-08-22 用户要求）：
--   1) horizontal_content_list 第一行插入「时间进度」（value={{time_progress}}，引擎从 active 周期
--      report_achievement_gen.progress_rate 取，如 71.0%）
--   2) keyname 缩短避免企微端换行（水平列表 keyname 太长自动换行）：原「门店零售金额完成率」
--      等 8~10 字 → 6 字内短名。6 项 = horizontal_content_list 上限（≤6）刚好。
--      （引擎在 preset 渲染前注入 time_progress；取不到 → 回退「—」，message-preset 兜底不拒投）
-- 幂等：jsonb_set 重复跑无害。
BEGIN;

UPDATE push_message_presets
SET card_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            (card_json - 'vertical_content_list'),
            '{card_image,url}', '"{{report_banner}}"'::jsonb, true
          ),
          '{card_action,url}', '"{{report_banner}}"'::jsonb, true
        ),
        '{source,desc}', '"{{target_name}}"'::jsonb, true
      ),
      '{main_title,title}', '"📊 数据日报"'::jsonb, true
    ),
    '{main_title,desc}', '"销售 {{sale_amount}} · 达成率 {{achievement_rate}}"'::jsonb, true
  ),
  '{horizontal_content_list}',
  jsonb_build_array(
    jsonb_build_object('keyname', '时间进度', 'value', '{{time_progress}}'),
    jsonb_build_object('keyname', '零售完成率', 'value', '{{achievement_rate}}'),
    jsonb_build_object('keyname', '配送完成率', 'value', '{{delivery_rate}}'),
    jsonb_build_object('keyname', '出库目标完成率', 'value', '{{outbound_amt_rate}}'),
    jsonb_build_object('keyname', '出库毛利完成率', 'value', '{{outbound_profit_rate}}'),
    jsonb_build_object('keyname', '毛利率', 'value', '{{outbound_margin}}')
  )::jsonb,
  true
),
  updated_at = now()
WHERE preset_id = 'scheduled-report-card';

COMMIT;

// services/semantic-generator/src/generators/achievement.ts
// 达成视图生成器（report_achievement_gen）：target×metric 矩阵（目标列表 + KPI）
// 铁律：各指标 actual 计算是"配置数据"（achievement-config，SQL 片段引用 t=targets），
//       生成器只做结构化组装（tgt 窗口 + metric CASE + closed 读 snapshot + 率），无业务字面量。
// perm 注入（2026-08-05）：config SQL 的 {{perm:alias}} / {{perm_skip:alias}} / {{perm_full:a:b}}
//   占位标记由本生成器替换为 perm.ts 模板调用（claim 逻辑不落 config，符合铁律第 6 条）。
//   tgt CTE 加 permFilterTarget（ALL 汇总行恒可见，门店行按 claim 过滤）。
// 前端只消费 target_level='total' 行（getTargetList/getTargetKpi/看板 lookup）。
import type { AchievementViewConfig } from '../types';
import { permFilterFact, permFilterTarget, permFilterFullJoin } from './perm.js';

/** 替换 config SQL 中的 perm 占位标记为 perm.ts 模板调用 */
function injectPerm(sql: string): string {
  return sql
    // {{perm_full:d:w}} -> COALESCE 双侧 perm 过滤（FULL JOIN 场景）
    .replace(/\{\{perm_full:([a-z]+):([a-z]+)\}\}/g, (_, a: string, b: string) => permFilterFullJoin(a, b))
    // {{perm_skip:w}} -> 仅 brands 过滤（wholesale_customer 无 branch_num 列）
    .replace(/\{\{perm_skip:([a-z]+)\}\}/g, (_, alias: string) => permFilterFact(alias, true))
    // {{perm:r}} -> brands + branch_nums 双维度过滤
    .replace(/\{\{perm:([a-z]+)\}\}/g, (_, alias: string) => permFilterFact(alias, false));
}

export function generateAchievementView(config: AchievementViewConfig): string {
  const { view_name, target_level, ctes, metrics } = config;
  const metricEntries = Object.entries(metrics);

  const tgtCte = `tgt AS (
  SELECT t.id, t.name, t.status, t.start_date, t.end_date, t.closed_at, t.system_book_code, t.branch_num,
    t.target_level, t.parent_target_id, t.target_type, t.category, t.breakdown_level, t.war_zone, t.region_l2,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t WHERE t.target_level = '${target_level}' AND ${permFilterTarget('t')}
)`;
  const metricCtes = Object.entries(ctes).map(([name, c]) => `${name} AS (\n  ${injectPerm(c.sql)}\n)`);
  const withList = [tgtCte, ...metricCtes];

  const actualCases = metricEntries.map(([code, m]) =>
    `       WHEN md.metric_code = '${code}' AND md.data_ready THEN ${m.cte}.actual_value`);
  const dataStatusCases = metricEntries.map(([code, m]) =>
    `       WHEN md.metric_code = '${code}' AND md.data_ready THEN\n         CASE WHEN ${m.cte}.days = 0 THEN 'missing' WHEN ${m.cte}.days < t.total_days THEN 'partial' ELSE 'complete' END`);
  const rateCases = metricEntries.map(([code, m]) =>
    `       WHEN mv.target_value > 0 AND md.metric_code = '${code}' AND md.data_ready AND ${m.cte}.actual_value IS NOT NULL THEN round((${m.cte}.actual_value / mv.target_value)::numeric, 4)`);
  const metricJoins = metricEntries.map(([code, m]) =>
    `  LEFT JOIN ${m.cte} ON ${m.cte}.target_id = t.id AND md.metric_code = '${code}'`);

  return `DROP VIEW IF EXISTS ${view_name} CASCADE;
CREATE VIEW ${view_name} AS
WITH ${withList.join(',\n')}
SELECT t.id AS target_id, t.name, t.status, t.start_date, t.end_date, t.closed_at,
  t.system_book_code, t.branch_num, t.target_level, t.parent_target_id, t.target_type, t.category,
  t.breakdown_level, t.war_zone, t.region_l2,
  b.branch_name, b.first_level_region AS war_zone_dim, b.second_level_region AS region_l2_dim, b.region_name, b.city,
  mv.metric_code, md.name AS metric_name, md.unit, md.data_ready, mv.target_value,
  CASE WHEN t.status = 'closed' THEN sn.actual_value
${actualCases.join('\n')} END AS actual_value,
  CASE WHEN t.status = 'closed' THEN sn.data_status
${dataStatusCases.join('\n')} ELSE 'not_ready' END AS data_status,
  t.total_days, t.days_elapsed,
  CASE WHEN mv.target_value > 0 AND t.status = 'closed' THEN sn.achievement_rate
${rateCases.join('\n')} END AS achievement_rate,
  CASE WHEN t.total_days > 0 THEN round(t.days_elapsed::numeric / t.total_days, 4) ELSE NULL END AS progress_rate
FROM tgt t
JOIN target_metric_values mv ON mv.target_id = t.id
JOIN metric_definitions md ON md.metric_code = mv.metric_code
LEFT JOIN dim_branch b ON b.system_book_code = t.system_book_code AND b.branch_num = t.branch_num
LEFT JOIN target_snapshots sn ON sn.target_id = t.id AND sn.metric_code = mv.metric_code
${metricJoins.join('\n')};
`;
}

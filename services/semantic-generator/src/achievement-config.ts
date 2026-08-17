// services/semantic-generator/src/achievement-config.ts
// 达成视图配置（report_achievement_gen）：target×metric 矩阵，每指标 actual 计算是配置数据
// （SQL 片段，GROUP BY 聚合引用 t=targets）。口径照迁移 118 的 total 级逻辑（sale/delivery/outbound）。
// 铁律：SQL 在配置不在生成器；生成器只组装。
// perm 注入：CTE SQL 含 {{perm:alias}} / {{perm_skip:alias}} / {{perm_full:a:b}} 占位标记，
//   achievement.ts 调 perm.ts 模板替换（claim 逻辑不落配置，符合铁律第 6 条）。
//
// 性能结构（2026-08-18，报表中心页 346s 根因链第四环）：
//   原形态 = SELECT t.id, (关联子查询 per target) FROM targets t —— 生成器按 target×metric
//   内联重算 8 次（视图 + 关联子查询双重 perm，见 193 迁移注释）；改 GROUP BY 聚合 + 生成器
//   MATERIALIZED 后，每个指标按 target 只聚合一次。语义与关联子查询逐 case 等价（生产实测对照）。
//   依赖 PG15 主键函数依赖（FROM targets t + GROUP BY t.id 可直选 t.start_date/end_date）。
//   WHERE t.target_level='total' 限定聚合范围（总目标仅 2 行，避免 532 目标全量扫）。
import type { AchievementViewConfig } from './types';

// 公共过滤片段：考核战区 EXISTS（门店粒度源表用）
const assessed = (alias: string) =>
  `EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = ${alias}.branch_num AND db.system_book_code = ${alias}.system_book_code AND is_assessed_war_zone(db.first_level_region))`;

export const achievementViewConfig: AchievementViewConfig = {
  view_name: 'report_achievement_gen',
  target_level: 'total',
  ctes: {
    sale: { sql: `SELECT t.id AS target_id,
  COALESCE(SUM(r.total_sale), 0) AS actual_value,
  count(DISTINCT r.biz_date) AS days
FROM targets t
LEFT JOIN report_daily_sales r
  ON (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
  AND r.biz_date BETWEEN t.start_date AND t.end_date
  AND ${assessed('r')}
  AND {{perm:r}}
WHERE t.target_level = 'total'
GROUP BY t.id` },
    delivery: { sql: `SELECT t.id AS target_id,
  COALESCE(SUM(d.out_money), 0) + COALESCE((
      SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
      WHERE w.system_book_code = '64188' AND w.biz_date BETWEEN t.start_date AND t.end_date
        AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))
        AND {{perm_skip:w}}
    ), 0) AS actual_value,
  count(DISTINCT d.biz_date) AS days
FROM targets t
LEFT JOIN report_daily_delivery d
  ON (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
  AND d.biz_date BETWEEN t.start_date AND t.end_date
  AND ${assessed('d')}
  AND {{perm:d}}
WHERE t.target_level = 'total'
GROUP BY t.id` },
    outbound_amt: { sql: `SELECT t.id AS target_id,
  COALESCE(SUM(COALESCE(d.out_money, 0) + COALESCE(w.wholesale_money, 0)), 0) AS actual_value,
  count(DISTINCT COALESCE(d.biz_date, w.biz_date)) AS days
FROM targets t
LEFT JOIN report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
  ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
  ON (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
  AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
  AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  AND {{perm_full:d:w}}
WHERE t.target_level = 'total'
GROUP BY t.id` },
    outbound_profit: { sql: `SELECT t.id AS target_id,
  CASE WHEN can_cost_visible()
     THEN COALESCE(SUM(COALESCE(d.profit_money, 0) + COALESCE(w.wholesale_profit, 0)), 0) ELSE NULL END AS actual_value,
  count(DISTINCT COALESCE(d.biz_date, w.biz_date)) AS days
FROM targets t
LEFT JOIN report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
  ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
  ON (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
  AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
  AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
  AND {{perm_full:d:w}}
WHERE t.target_level = 'total'
GROUP BY t.id` },
  },
  metrics: {
    sale: { data_ready: true, cte: 'sale' },
    delivery: { data_ready: true, cte: 'delivery' },
    outbound_amt: { data_ready: true, cte: 'outbound_amt' },
    outbound_profit: { data_ready: true, cte: 'outbound_profit', cost_sensitive: true },
  },
};

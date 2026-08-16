// services/semantic-generator/src/achievement-config.ts
// 达成视图配置（report_achievement_gen）：target×metric 矩阵，每指标 actual 计算是配置数据
// （SQL 片段，关联子查询引用 t=targets 行）。口径照迁移 118 的 total 级逻辑（sale/delivery/outbound）。
// 铁律：SQL 在配置不在生成器；生成器只组装。
// perm 注入：CTE SQL 含 {{perm:alias}} / {{perm_skip:alias}} / {{perm_full:a:b}} 占位标记，
//   achievement.ts 调 perm.ts 模板替换（claim 逻辑不落配置，符合铁律第 6 条）。
import type { AchievementViewConfig } from './types';

// 公共过滤片段：考核战区 EXISTS（门店粒度源表用）
const assessed = (alias: string) =>
  `EXISTS (SELECT 1 FROM dim_branch db WHERE db.branch_num = ${alias}.branch_num AND db.system_book_code = ${alias}.system_book_code AND is_assessed_war_zone(db.first_level_region))`;

export const achievementViewConfig: AchievementViewConfig = {
  view_name: 'report_achievement_gen',
  target_level: 'total',
  ctes: {
    sale: { sql: `SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(r.total_sale), 0) FROM report_daily_sales r
    WHERE (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
      AND ${assessed('r')}
      AND {{perm:r}}
  ) AS actual_value,
  (SELECT count(DISTINCT r.biz_date) FROM report_daily_sales r
    WHERE (t.system_book_code = 'ALL' OR r.system_book_code = t.system_book_code)
      AND r.biz_date BETWEEN t.start_date AND t.end_date
      AND ${assessed('r')}
      AND {{perm:r}}
  ) AS days
FROM targets t` },
    delivery: { sql: `SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(d.out_money), 0) + COALESCE((
      SELECT SUM(w.wholesale_amount) FROM report_daily_wholesale_customer w
      WHERE w.system_book_code = '64188' AND w.biz_date BETWEEN t.start_date AND t.end_date
        AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code = '64188' AND db.branch_name = w.client_name AND is_assessed_war_zone(db.first_level_region))
        AND {{perm_skip:w}}
    ), 0) FROM report_daily_delivery d
    WHERE (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
      AND d.biz_date BETWEEN t.start_date AND t.end_date
      AND ${assessed('d')}
      AND {{perm:d}}
  ) AS actual_value,
  (SELECT count(DISTINCT d.biz_date) FROM report_daily_delivery d
    WHERE (t.system_book_code = 'ALL' OR d.system_book_code = t.system_book_code)
      AND d.biz_date BETWEEN t.start_date AND t.end_date
      AND ${assessed('d')}
      AND {{perm:d}}
  ) AS days
FROM targets t` },
    outbound_amt: { sql: `SELECT t.id AS target_id,
  (SELECT COALESCE(SUM(COALESCE(d.out_money, 0) + COALESCE(w.wholesale_money, 0)), 0)
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
     AND {{perm_full:d:w}}
  ) AS actual_value,
  (SELECT count(DISTINCT COALESCE(d.biz_date, w.biz_date))
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
     AND {{perm_full:d:w}}
  ) AS days
FROM targets t` },
    outbound_profit: { sql: `SELECT t.id AS target_id,
  (SELECT CASE WHEN can_cost_visible()
     THEN COALESCE(SUM(COALESCE(d.profit_money, 0) + COALESCE(w.wholesale_profit, 0)), 0) ELSE NULL END
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
     AND {{perm_full:d:w}}
  ) AS actual_value,
  (SELECT count(DISTINCT COALESCE(d.biz_date, w.biz_date))
   FROM report_daily_delivery d FULL OUTER JOIN report_daily_wholesale w
     ON d.system_book_code = w.system_book_code AND d.biz_date = w.biz_date AND d.branch_num = w.branch_num AND d.category_group = w.category_group
   WHERE (t.system_book_code = 'ALL' OR COALESCE(d.system_book_code, w.system_book_code) = t.system_book_code)
     AND COALESCE(d.biz_date, w.biz_date) BETWEEN t.start_date AND t.end_date
     AND (d.category_group IN ('水果','标品','耗材') OR w.category_group IN ('水果','标品','耗材'))
     AND {{perm_full:d:w}}
  ) AS days
FROM targets t` },
  },
  metrics: {
    sale: { data_ready: true, cte: 'sale' },
    delivery: { data_ready: true, cte: 'delivery' },
    outbound_amt: { data_ready: true, cte: 'outbound_amt' },
    outbound_profit: { data_ready: true, cte: 'outbound_profit', cost_sensitive: true },
  },
};

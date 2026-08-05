// services/semantic-generator/src/generators/qa.ts
// C2 视图上游断言对账视图（L4，spec 2026-08-03-data-accuracy-semantic-layer-design）
// 产出 ${view}_qa：一行一个断言，列 = (metric, view_sum, ref_sum, diff)
// view_sum 从视图按 view_sum_filter 独立 SUM；ref_sum 用 qa-checks 声明的独立重算 SQL。
// 静态产物入 database/generated，DROP+CREATE 幂等（与 _audit 同模式）。
import type { ViewAssertion } from '../qa-types.js';

export function generateQaView(assertions: ViewAssertion[]): string {
  if (assertions.length === 0) return '';
  const view = assertions[0].view;
  const rows = assertions
    .map((a) => {
      // 长表视图（achievement：每行 target×metric）SUM 列不是 metric 标签而是 actual_value，
      // 用 a.sum_col ?? a.metric 兼顾宽表（无 sum_col）与长表（显式 sum_col）。
      const sumCol = a.sum_col ?? a.metric;
      return `  SELECT '${a.metric}' AS metric,
    COALESCE((SELECT SUM(${sumCol}) FROM ${view} WHERE ${a.view_sum_filter}), 0) AS view_sum,
    COALESCE((${a.ref_sql}), 0) AS ref_sum`;
    })
    .join('\n  UNION ALL\n');

  return `DROP VIEW IF EXISTS ${view}_qa;
CREATE VIEW ${view}_qa AS
SELECT metric, view_sum, ref_sum, ROUND(view_sum - ref_sum, 2) AS diff
FROM (
${rows}
) t;
`;
}

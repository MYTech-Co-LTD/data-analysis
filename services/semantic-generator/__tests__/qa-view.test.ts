import { describe, it, expect } from 'vitest';
import { generateQaView } from '../src/generators/qa.js';
import qaChecks from '../src/qa-checks.json';
import type { ViewAssertion } from '../src/qa-types.js';

// 按视图分组（对齐 index.ts:65 的调用约定：generateQaView 接受同视图断言组）
function groupByView(assertions: ViewAssertion[]): ViewAssertion[][] {
  const groups = new Map<string, ViewAssertion[]>();
  for (const a of assertions) {
    if (!groups.has(a.view)) groups.set(a.view, []);
    groups.get(a.view)!.push(a);
  }
  return [...groups.values()];
}

describe('generateQaView', () => {
  const assertions = qaChecks as ViewAssertion[];
  const groups = groupByView(assertions);

  it('对每视图产出 DROP+CREATE 幂等视图', () => {
    for (const g of groups) {
      const sql = generateQaView(g);
      expect(sql).toContain(`DROP VIEW IF EXISTS ${g[0].view}_qa;`);
      expect(sql).toContain(`CREATE VIEW ${g[0].view}_qa AS`);
    }
  });

  it('每断言一行，含 view_sum（过滤合计行）与 ref_sum', () => {
    for (const g of groups) {
      const sql = generateQaView(g);
      for (const a of g) {
        expect(sql).toContain(`SUM(${a.metric}) FROM ${a.view} WHERE ${a.view_sum_filter}`);
      }
    }
    // 抽验 ref_sql 原文（sale_amount 考核过滤 + sale_target tmv + wholesale_daily LEAST）
    const bmSql = generateQaView(groups.find((g) => g[0].view === 'report_brand_metric_gen')!);
    expect(bmSql).toContain(`SELECT COALESCE(SUM(s.total_sale), 0)`);
    expect(bmSql).toContain(`SELECT COALESCE(SUM(tmv.target_value), 0)`);
    const wdSql = generateQaView(groups.find((g) => g[0].view === 'report_wholesale_daily_gen')!);
    expect(wdSql).toContain(`LEAST(current_date, t.end_date)`);
  });

  it('空断言返回空串', () => {
    expect(generateQaView([])).toBe('');
  });
});

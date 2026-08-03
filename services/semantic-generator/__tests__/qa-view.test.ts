import { describe, it, expect } from 'vitest';
import { generateQaView } from '../src/generators/qa.js';
import qaChecks from '../src/qa-checks.json';
import type { ViewAssertion } from '../src/qa-types.js';

describe('generateQaView', () => {
  const assertions = qaChecks as ViewAssertion[];

  it('对每视图产出 DROP+CREATE 幂等视图', () => {
    const sql = generateQaView(assertions);
    expect(sql).toContain(`DROP VIEW IF EXISTS ${assertions[0].view}_qa;`);
    expect(sql).toContain(`CREATE VIEW ${assertions[0].view}_qa AS`);
  });

  it('每断言一行，含 view_sum（过滤合计行）与 ref_sum', () => {
    const sql = generateQaView(assertions);
    for (const a of assertions) {
      expect(sql).toContain(`SUM(${a.metric}) FROM ${a.view} WHERE ${a.view_sum_filter}`);
      expect(sql).toContain(`SELECT COALESCE(SUM(s.total_sale), 0)`); // ref_sql 原文
    }
  });

  it('空断言返回空串', () => {
    expect(generateQaView([])).toBe('');
  });
});

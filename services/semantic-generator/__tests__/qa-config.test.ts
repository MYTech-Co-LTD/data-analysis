import { describe, it, expect } from 'vitest';
import detailSources from '../src/detail-sources.json';
import qaChecks from '../src/qa-checks.json';
import type { DetailSource, ViewAssertion } from '../src/qa-types.js';

function isDetailSource(x: any): x is DetailSource {
  return x && typeof x.name === 'string' && Array.isArray(x.natural_key)
    && x.natural_key.length > 0 && typeof x.glob === 'string'
    && x.glob.endsWith('all.parquet') && typeof x.agg_table === 'string'
    && Array.isArray(x.agg_key) && Array.isArray(x.agg_metric)
    && typeof x.brand_expr === 'string' && typeof x.detail_date_expr === 'string'
    && typeof x.tolerance === 'number';
}

describe('qa 配置', () => {
  it('detail-sources: 三张明细全注册且结构合法', () => {
    expect(detailSources).toHaveLength(3);
    expect(detailSources.every(isDetailSource)).toBe(true);
    expect(detailSources.map((s) => s.name).sort()).toEqual(['delivery', 'retail', 'wholesale']);
  });
  it('detail-sources: natural_key 禁含 id（lemeng 分页每次重新生成 id 致 DISTINCT * 失效）', () => {
    for (const s of detailSources) {
      expect(s.natural_key).not.toContain('id');
    }
  });
  it('detail-sources: 聚合列能对上真实聚合表列名（手滑写错会在 C1 对账暴露）', () => {
    const aggCols: Record<string, string[]> = {
      report_daily_sales: ['system_book_code', 'branch_num', 'biz_date', 'total_sale', 'total_profit'],
      report_daily_delivery: ['system_book_code', 'branch_num', 'biz_date', 'out_money', 'profit_money'],
      report_daily_wholesale: ['system_book_code', 'branch_num', 'biz_date', 'wholesale_money', 'wholesale_profit'],
    };
    for (const s of detailSources) {
      const cols = aggCols[s.agg_table];
      expect(cols, `${s.name} 缺聚合表列清单`).toBeDefined();
      for (const k of s.agg_key) expect(cols).toContain(k);
      for (const m of s.agg_metric) expect(cols).toContain(m.agg);
    }
  });
  it('qa-checks: 结构合法，ref_sql 非空', () => {
    for (const c of qaChecks as ViewAssertion[]) {
      expect(typeof c.view).toBe('string');
      expect(typeof c.metric).toBe('string');
      expect(typeof c.view_sum_filter).toBe('string');
      expect(c.ref_sql.trim().length).toBeGreaterThan(10);
      expect(c.ref_sql.startsWith('SELECT')).toBe(true);
      expect(typeof c.tolerance).toBe('number');
    }
  });
});

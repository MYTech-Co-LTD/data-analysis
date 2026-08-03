import { describe, it, expect } from 'vitest';
import { buildD1Sql } from '../d1';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';

describe('buildD1Sql', () => {
  const retail = detailSources.find((s) => s.name === 'retail')!;
  const sql = buildD1Sql(retail, '20260701', '20260731');

  it('引用 glob 与日期过滤', () => {
    expect(sql).toContain("read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/*-*-*/all.parquet'");
    expect(sql).toContain("BETWEEN '20260701' AND '20260731'");
  });
  it('自然键含分支+单号+行号，不含 id', () => {
    expect(sql).toContain('order_no');
    expect(sql).toContain('order_detail_num');
    expect(sql).not.toContain('COUNT(DISTINCT id');
  });
  it('HAVING 抓重复（count>distinct）', () => {
    expect(sql).toMatch(/HAVING COUNT\(\*\) > COUNT\(DISTINCT CONCAT_WS/);
  });
});

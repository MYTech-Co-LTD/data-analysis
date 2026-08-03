import { describe, it, expect } from 'vitest';
import { buildD1Sql, buildDayGlob } from '../d1';
import detailSources from '../../../../services/semantic-generator/src/detail-sources.json';
import type { DetailSource } from '../types';

describe('buildD1Sql', () => {
  const retail = detailSources.find((s) => s.name === 'retail')! as DetailSource;
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
  it('globOverride 时优先用覆盖 glob（采集后日窗口）', () => {
    const overridden = buildD1Sql(retail, '20260728', '20260728', 's3://lemeng-datasource/lemeng/retail_detail/*/2026-07-28/all.parquet');
    expect(overridden).toContain("read_parquet('s3://lemeng-datasource/lemeng/retail_detail/*/2026-07-28/all.parquet'");
    expect(overridden).not.toContain('*/*-*-*/all.parquet');
  });
});

describe('buildDayGlob', () => {
  it('retail（iso 目录 YYYY-MM-DD）：compact 日转 ISO 日期段', () => {
    const retail = detailSources.find((s) => s.name === 'retail')! as DetailSource;
    expect(buildDayGlob(retail, '20260728')).toBe('s3://lemeng-datasource/lemeng/retail_detail/*/2026-07-28/all.parquet');
  });
  it('delivery（compact 目录 YYYYMMDD）：日期段原样替换', () => {
    const delivery = detailSources.find((s) => s.name === 'delivery')! as DetailSource;
    expect(buildDayGlob(delivery, '20260728')).toBe('s3://lemeng-datasource/lemeng/transfer_detail/*/20260728/all.parquet');
  });
  it('wholesale（compact 目录 YYYYMMDD）：日期段原样替换', () => {
    const wholesale = detailSources.find((s) => s.name === 'wholesale')! as DetailSource;
    expect(buildDayGlob(wholesale, '20260728')).toBe('s3://lemeng-datasource/lemeng/wholesale_detail/*/20260728/all.parquet');
  });
});

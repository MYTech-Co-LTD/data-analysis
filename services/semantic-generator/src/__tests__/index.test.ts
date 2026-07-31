import { describe, it, expect, vi } from 'vitest';
import { runGenerator } from '../index.js';

describe('runGenerator', () => {
  it('空 viewConfigs → 不产出、不 EXPLAIN、返回空', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    const r = await runGenerator({ client: client as any, viewConfigs: [], outDir: '/tmp/x' });
    expect(r.produced).toEqual([]);
    expect(r.explainFailures).toEqual([]);
    // readRegistry 会调用 client.query 两次（metric_registry + metric_sources）
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('有 viewConfig 但无 SQL 产出（P0 生成器未实现 Tier1）→ produced 仍空，不抛错', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] })
    };
    const r = await runGenerator({
      client: client as any,
      viewConfigs: [{ view_name: 'report_brand_metric_gen', metrics: ['sale_amount'], dim_code: null, levels: [], target_metric_codes: [] }],
      outDir: '/tmp/x',
    });
    expect(r.produced).toEqual([]);
    expect(r.explainFailures).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { runGenerator } from '../index.js';

// 构造 mock registry 行（与 tier1.test.ts 一致）
function mockMetricRow(code: string) {
  return {
    metric_code: code,
    measure_type: 'base',
    fact_table: 'report_daily_sales',
    value_column: 'total_sale',
    agg: 'SUM',
    formula: null,
    depends_on: [],
    additive: true,
    cost_sensitive: false,
    unit: '元',
    enabled: true,
    data_ready: true,
    name: code,
    description: null,
    business_formula: null,
  };
}

describe('runGenerator', () => {
  it('空 viewConfigs → 不产出、不 EXPLAIN、返回空', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [mockMetricRow('sale_amount')] }) // metric_registry
        .mockResolvedValueOnce({ rows: [] }) // metric_sources
    };
    const r = await runGenerator({ client: client as any, viewConfigs: [], outDir: '/tmp/x' });
    expect(r.produced).toEqual([]);
    expect(r.explainFailures).toEqual([]);
  });

  it('有 viewConfig 且 registry 有数据 → 调用生成器产出视图名', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rows: [
            { ...mockMetricRow('sale_amount'), metric_code: 'sale_amount' },
            { ...mockMetricRow('delivery_amount'), metric_code: 'delivery_amount' },
          ]
        })
        .mockResolvedValueOnce({
          rows: [
            { metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null },
            { metric_code: 'delivery_amount', source_table: 'report_daily_delivery', source_column: 'out_money', source_filter: null, note: null },
          ]
        })
    };
    const r = await runGenerator({
      client: client as any,
      viewConfigs: [{ view_name: 'report_brand_metric_gen', metrics: ['sale_amount', 'delivery_amount'], dim_code: 'brand', levels: ['brand'], target_metric_codes: [] }],
      outDir: '/tmp/x',
    });
    expect(r.produced).toContain('report_brand_metric_gen');
    expect(r.explainFailures).toEqual([]);
  });
});

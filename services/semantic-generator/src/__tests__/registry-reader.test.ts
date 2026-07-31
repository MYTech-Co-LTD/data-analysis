import { describe, it, expect } from 'vitest';
import { parseMetric, parseSource } from '../registry-reader.js';

describe('parseMetric', () => {
  it('把 PG 行（depends_on 是 jsonb 串）解析成 Metric', () => {
    const row = {
      metric_code: 'outbound_amount',
      name: '出库金额',
      description: '总部→所有客户',
      business_formula: 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
      measure_type: 'derived',
      fact_table: null,
      value_column: null,
      agg: null,
      formula: 'delivery_amount + wholesale_pp_amount + wholesale_ext_amount',
      depends_on: '["delivery_amount","wholesale_pp_amount","wholesale_ext_amount"]',
      additive: true,
      cost_sensitive: false,
      unit: '元',
      data_ready: true,
      enabled: true,
    };
    const m = parseMetric(row);
    expect(m.metric_code).toBe('outbound_amount');
    expect(m.measure_type).toBe('derived');
    expect(m.additive).toBe(true);
    expect(m.depends_on).toEqual([
      'delivery_amount', 'wholesale_pp_amount', 'wholesale_ext_amount',
    ]);
  });

  it('base 指标 depends_on 为空数组', () => {
    const row = {
      metric_code: 'sale_amount', name: '销售金额', description: null,
      business_formula: null, measure_type: 'base', fact_table: 'retail_detail',
      value_column: 'sale_money', agg: 'SUM', formula: null,
      depends_on: '[]', additive: true, cost_sensitive: false, unit: '元',
      data_ready: true, enabled: true,
    };
    expect(parseMetric(row).depends_on).toEqual([]);
    expect(parseMetric(row).agg).toBe('SUM');
  });
});

describe('parseSource', () => {
  it('解析 source 行保留 source_filter', () => {
    const row = {
      metric_code: 'sale_target', source_table: 'target_metric_values',
      source_column: 'target_value', source_filter: "metric_code='sale'",
      note: '销售目标',
    };
    const s = parseSource(row);
    expect(s.metric_code).toBe('sale_target');
    expect(s.source_filter).toBe("metric_code='sale'");
  });
});

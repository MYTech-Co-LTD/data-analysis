import { describe, it, expect } from 'vitest';
import { generateTier1View } from '../src/generators/tier1';
import { Metric, MetricSource, ViewConfig } from '../src/types';

const baseMetric = (code: string, col: string): Metric => ({
  metric_code: code, name: code, measure_type: 'base', fact_table: 'report_daily_sales',
  value_column: col, agg: 'SUM', formula: null, depends_on: [], additive: true,
  cost_sensitive: false, unit: '元', data_ready: true, enabled: true,
  description: null, business_formula: null,
});

describe('Tier2 window context', () => {
  it('tgt CTE 含 total_days/days_elapsed/latest_day 当 target_window=true', () => {
    const config: ViewConfig = {
      view_name: 'v_test', metrics: ['sale_amount'], dim_code: 'brand',
      levels: [], target_metric_codes: [],
      scope: { target_window: true, assessed_war_zone: false },
    };
    const sql = generateTier1View(config, [baseMetric('sale_amount', 'total_sale')],
      [{ metric_code: 'sale_amount', source_table: 'report_daily_sales', source_column: 'total_sale', source_filter: null, note: null }]);
    expect(sql).toContain('total_days');
    expect(sql).toContain('days_elapsed');
    expect(sql).toContain('latest_day');
    expect(sql).toContain('GREATEST(LEAST(current_date');
  });
});

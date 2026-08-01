import type { PoolClient } from 'pg';
import type { Metric, MetricSource } from './types.js';

// 纯函数：PG 行（depends_on 为 JSON 字符串）→ typed Metric
export function parseMetric(row: Record<string, unknown>): Metric {
  return {
    metric_code: String(row.metric_code),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    business_formula: row.business_formula == null ? null : String(row.business_formula),
    measure_type: row.measure_type as Metric['measure_type'],
    fact_table: row.fact_table == null ? null : String(row.fact_table),
    value_column: row.value_column == null ? null : String(row.value_column),
    agg: row.agg == null ? null : (row.agg as Metric['agg']),
    formula: row.formula == null ? null : String(row.formula),
    formula_ast: (row.formula_ast ?? null) as Metric['formula_ast'],  // JSONB -> Ast 对象
    depends_on: Array.isArray(row.depends_on)
      ? row.depends_on.map(String)
      : JSON.parse(String(row.depends_on ?? '[]')),
    additive: Boolean(row.additive),
    cost_sensitive: Boolean(row.cost_sensitive),
    unit: String(row.unit),
    data_ready: Boolean(row.data_ready),
    enabled: Boolean(row.enabled),
  };
}

export function parseSource(row: Record<string, unknown>): MetricSource {
  return {
    metric_code: String(row.metric_code),
    source_table: String(row.source_table),
    source_column: row.source_column == null ? null : String(row.source_column),
    source_filter: row.source_filter == null ? null : String(row.source_filter),
    note: row.note == null ? null : String(row.note),
  };
}

export async function readRegistry(client: PoolClient): Promise<{ metrics: Metric[]; sources: MetricSource[] }> {
  const metricRes = await client.query('SELECT * FROM metric_registry ORDER BY metric_code');
  const sourceRes = await client.query('SELECT * FROM metric_sources ORDER BY metric_code');
  return {
    metrics: metricRes.rows.map(parseMetric),
    sources: sourceRes.rows.map(parseSource),
  };
}

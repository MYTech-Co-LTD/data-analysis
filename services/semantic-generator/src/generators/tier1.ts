import { Metric, MetricSource, ViewConfig } from '../types';

type Ctx = { metrics: Metric[]; sources: MetricSource[]; cteOf: Map<string, string> };

function baseRef(metric: Metric, ctx: Ctx): string {
  const cte = ctx.cteOf.get(metric.metric_code);
  if (!cte) throw new Error(`base metric ${metric.metric_code} 缺 CTE 映射`);
  return `${cte}.${metric.metric_code}`;
}

function expandAdditive(metric: Metric, ctx: Ctx): string {
  let expr = metric.formula ?? '';
  for (const dep of metric.depends_on) {
    const depMetric = ctx.metrics.find(m => m.metric_code === dep);
    if (!depMetric) continue;
    const depExpr = metricRef(depMetric, ctx);
    expr = expr.replace(new RegExp(`\\b${dep}\\b`, 'g'), depExpr);
  }
  return expr;
}

function expandRate(metric: Metric, ctx: Ctx): string {
  const formula = metric.formula ?? '';
  const parts = formula.split('/');
  if (parts.length !== 2) throw new Error(`rate metric ${metric.metric_code} 公式非 A/B 结构: ${formula}`);
  const num = expandToken(parts[0].trim(), metric, ctx);
  const den = expandToken(parts[1].trim(), metric, ctx);
  return `${num} / NULLIF(${den}, 0)`;
}

function expandToken(token: string, owner: Metric, ctx: Ctx): string {
  const m = ctx.metrics.find(x => x.metric_code === token);
  if (!m) return token;
  return `(${metricRef(m, ctx)})`;
}

function metricRef(metric: Metric, ctx: Ctx): string {
  if (metric.measure_type === 'base') return baseRef(metric, ctx);
  if (metric.additive) return expandAdditive(metric, ctx);
  return expandRate(metric, ctx);
}

function maskCost(expr: string, metric: Metric): string {
  if (!metric.cost_sensitive) return expr;
  return `CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN ${expr} END`;
}

export function generateTier1View(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const { view_name, metrics: metricCodes, dim_code } = config;
  const dimKey = dim_code === 'brand' ? 'system_book_code' : 'branch_num';

  // 收集所选指标涉及的全部 base 指标（含 derived 的 depends_on 递归）
  const visited = new Set<string>();
  const leaves: Metric[] = [];
  function collect(m: Metric) {
    if (visited.has(m.metric_code)) return;
    visited.add(m.metric_code);
    if (m.measure_type === 'base') {
      leaves.push(m);
    } else {
      for (const dep of m.depends_on) {
        const d = metrics.find(x => x.metric_code === dep);
        if (d) collect(d);
      }
    }
  }
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (m) collect(m);
  }

  // base 指标按 source_table 分组 → 各一个 CTE
  const tables: string[] = [];
  const tableMetrics = new Map<string, Metric[]>();
  for (const leaf of leaves) {
    const src = sources.find(s => s.metric_code === leaf.metric_code);
    if (!src) continue;
    if (!tableMetrics.has(src.source_table)) {
      tableMetrics.set(src.source_table, []);
      tables.push(src.source_table);
    }
    tableMetrics.get(src.source_table)!.push(leaf);
  }

  const cteList: string[] = [];
  const cteOf = new Map<string, string>(); // metric_code → cteN
  tables.forEach((tbl, idx) => {
    const cteName = `cte${idx}`;
    const mets = tableMetrics.get(tbl)!;
    const cols = mets.map(m => {
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      const filter = src.source_filter ? `\n  WHERE ${src.source_filter.replace(/\bs\./g, '')}` : '';
      return `  SELECT ${dimKey},\n    SUM(${src.source_column}) AS ${m.metric_code}\n  FROM ${tbl}${filter}\n  GROUP BY ${dimKey}`;
    });
    cteList.push(`${cteName} AS (\n${cols.join('\n  UNION ALL\n')}\n)`);
    for (const m of mets) cteOf.set(m.metric_code, cteName);
  });

  // main SELECT 列
  const sel: string[] = [];
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m) continue;
    if (m.measure_type === 'base') {
      sel.push(`${baseRef(m, { metrics, sources, cteOf })} AS ${code}`);
    } else {
      const expr = metricRef(m, { metrics, sources, cteOf });
      sel.push(`${maskCost(expr, m)} AS ${code}`);
    }
  }

  // brand_code 维度列：从所有 CTE 的 dimKey 中选非 NULL 的
  const brandCodeExpr = tables.length > 1
    ? `COALESCE(${tables.map((_, i) => `cte${i}.${dimKey}`).join(', ')})`
    : `cte0.${dimKey}`;
  const dimCol = dim_code === 'brand' ? `${brandCodeExpr} AS brand_code` : 'branch_num';
  sel.unshift(dimCol);

  // FROM + FULL OUTER JOIN
  const joinOns = tables.slice(1).map((_, i) => {
    return `FULL OUTER JOIN cte${i + 1} ON cte${i + 1}.${dimKey} = cte0.${dimKey}`;
  });

  return `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
${cteList.length ? `WITH ${cteList.join(',\n')}\n` : ''}SELECT ${sel.join(',\n  ')}
FROM cte0
${joinOns.join('\n')}`;
}

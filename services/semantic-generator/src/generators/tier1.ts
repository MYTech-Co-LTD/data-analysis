import { Metric, MetricSource, ViewConfig } from '../types';

/**
 * Tier1 生成器
 *
 * 能力：base 聚合 + additive derived 展开 + 率重算 + cost脱敏
 *      + scope（目标日期窗口 + 考核战区）+ target 值 join + 合计行 + 维表 cross-join + 列别名
 *
 * 结构（scoped + total_row 时，对应 report_brand_metric_gen）：
 *   WITH tgt AS (active total target 日期窗口),
 *        cte_actualN AS (base 表按 tgt 窗口 + assessed 过滤聚合),
 *        cte_targetN AS (target_metric_values 按分解级聚合),
 *        brand_rows AS (dim_brand ⊥ tgt LEFT JOIN 各 cte + derived + cost mask)
 *   SELECT * FROM brand_rows
 *   UNION ALL 合计行
 */

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
    expr = expr.replace(new RegExp(`\\b${dep}\\b`, 'g'), `COALESCE(${depExpr}, 0)`);
  }
  return expr;
}

function expandRate(metric: Metric, ctx: Ctx): string {
  const formula = metric.formula ?? '';
  const parts = formula.split('/');
  if (parts.length !== 2) throw new Error(`rate metric ${metric.metric_code} 公式非 A/B 结构: ${formula}`);
  const num = expandToken(parts[0].trim(), ctx);
  const den = expandToken(parts[1].trim(), ctx);
  return `COALESCE(${num}, 0) / NULLIF(COALESCE(${den}, 0), 0)`;
}

function expandToken(token: string, ctx: Ctx): string {
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

/** 收集所选指标涉及的全部 base 叶子指标（含 derived 递归依赖） */
function collectLeaves(metricCodes: string[], metrics: Metric[]): Metric[] {
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
  return leaves;
}

export function generateTier1View(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const {
    view_name, metrics: metricCodes, dim_code,
    scope, total_row, dim_table, aliases,
  } = config;

  const dimKey = dim_code === 'brand' ? 'system_book_code' : 'branch_num';
  const scoped = scope?.target_window || scope?.assessed_war_zone;
  const useTargetWindow = scope?.target_window ?? false;
  const useAssessed = scope?.assessed_war_zone ?? false;

  const leaves = collectLeaves(metricCodes, metrics);

  // 识别 daily 指标：selected derived，formula 含 FILTER(biz_date=latest_day)
  // → 在 depends_on[0] 所属 base 的 actual CTE 里额外产 FILTER(latest_day) 聚合列
  // dailyMap: baseMetricCode → dailyMetricCode；dailyCodes 用于 SELECT 阶段按 base 引用
  const dailyMap = new Map<string, string>();
  const dailyCodes = new Set<string>();
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m || m.measure_type !== 'derived') continue;
    const formula = m.formula ?? '';
    if (!/FILTER\s*\(\s*biz_date\s*=\s*latest_day\s*\)/i.test(formula)) continue;
    const baseCode = m.depends_on[0];
    if (!baseCode) continue;
    dailyMap.set(baseCode, m.metric_code);
    dailyCodes.add(m.metric_code);
  }

  // base 叶子按 (source_table, source_filter) 分组
  // target_metric_values 单独走 target CTE，不进 actual CTE
  const actualGroups = new Map<string, { table: string; filter: string | null; metrics: Metric[] }>();
  const targetLeaves: Metric[] = [];
  for (const leaf of leaves) {
    const src = sources.find(s => s.metric_code === leaf.metric_code);
    if (!src) continue;
    if (src.source_table === 'target_metric_values') {
      targetLeaves.push(leaf);
      continue;
    }
    const key = `${src.source_table}|${src.source_filter ?? ''}`;
    if (!actualGroups.has(key)) actualGroups.set(key, { table: src.source_table, filter: src.source_filter, metrics: [] });
    actualGroups.get(key)!.metrics.push(leaf);
  }

  const cteList: string[] = [];
  const cteOf = new Map<string, string>();

  // tgt CTE（目标窗口 + 窗口列 total_days/days_elapsed/latest_day，照手写视图 120 口径）
  if (useTargetWindow) {
    cteList.push(`tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='total' AND status='active'
)`);
  }

  // actual base CTE
  let cteIdx = 0;
  for (const g of actualGroups.values()) {
    const cteName = `cte${cteIdx++}`;
    const cols = g.metrics.map(m => {
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      return `SUM(s.${src.source_column}) AS ${m.metric_code}`;
    });
    // daily FILTER 列：仅 useTargetWindow 时（无窗口则无 tgt.latest_day，跳过避免无效 SQL）
    if (useTargetWindow) {
      for (const m of g.metrics) {
        const dailyCode = dailyMap.get(m.metric_code);
        if (!dailyCode) continue;
        const src = sources.find(s => s.metric_code === m.metric_code)!;
        cols.push(`SUM(s.${src.source_column}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
      }
    }
    const colsStr = cols.join(',\n    ');

    const joins: string[] = [];
    let selectDims = `s.${dimKey}`;
    let groupDims = `s.${dimKey}`;
    let where: string[] = [];

    if (g.filter) where.push(g.filter.replace(/\bs\./g, 's.'));

    if (useTargetWindow) {
      joins.push(`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date`);
      selectDims = `tgt.target_id, s.${dimKey}`;
      groupDims = `tgt.target_id, s.${dimKey}`;
    }
    if (useAssessed) {
      joins.push(`JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num`);
      where.push(`is_assessed_war_zone(db.first_level_region)`);
    }

    const whereClause = where.length ? `\n  WHERE ${where.join(' AND ')}` : '';
    cteList.push(`${cteName} AS (
  SELECT ${selectDims},
    ${colsStr}
  FROM ${g.table} s${joins.length ? '\n  ' + joins.join('\n  ') : ''}${whereClause}
  GROUP BY ${groupDims}
)`);
    for (const m of g.metrics) {
      cteOf.set(m.metric_code, cteName);
      const dailyCode = dailyMap.get(m.metric_code);
      if (dailyCode) cteOf.set(dailyCode, cteName);
    }
  }

  // target base CTE（target_metric_values）
  for (const tleaf of targetLeaves) {
    const cteName = `cte${cteIdx++}`;
    const src = sources.find(s => s.metric_code === tleaf.metric_code)!;
    // source_filter 形如 metric_code='sale'
    const metricFilter = src.source_filter ?? '';
    const assessedCond = useAssessed
      ? ` AND EXISTS (SELECT 1 FROM dim_branch db WHERE db.system_book_code=t.system_book_code AND db.branch_num=t.branch_num AND is_assessed_war_zone(db.first_level_region))`
      : '';
    cteList.push(`${cteName} AS (
  SELECT t.parent_target_id AS target_id, t.system_book_code,
    SUM(tmv.target_value) AS ${tleaf.metric_code}
  FROM targets t JOIN target_metric_values tmv ON tmv.target_id=t.id
  WHERE t.breakdown_level='store' AND ${metricFilter || 'true'}${assessedCond}
  GROUP BY t.parent_target_id, t.system_book_code
)`);
    cteOf.set(tleaf.metric_code, cteName);
  }

  // 组装 main SELECT
  const ctx: Ctx = { metrics, sources, cteOf };
  const sel: string[] = [];

  // 维度列
  if (useTargetWindow) sel.push(`tgt.target_id`);
  if (dim_table) {
    sel.push(`b.${dimKey} AS ${dimKey}`);
  } else if (useTargetWindow) {
    sel.push(`cte0.${dimKey} AS ${dimKey}`);
  } else {
    sel.push(`${dimKey} AS ${dimKey}`);
  }
  if (dim_code === 'brand' && dim_table) sel.push(`b.brand_name`);

  // 指标列
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m) continue;
    // daily 指标已在 actual CTE 聚合，SELECT 阶段像 base 一样直接引用 cte 列
    const treatAsBase = m.measure_type === 'base' || dailyCodes.has(code);
    const expr = treatAsBase ? baseRef(m, ctx) : metricRef(m, ctx);
    const masked = treatAsBase ? expr : maskCost(expr, m);
    // base 的 cost 脱敏
    const finalExpr = treatAsBase && m.cost_sensitive ? maskCost(expr, m) : masked;
    const outName = aliases?.[code] ?? code;
    sel.push(`${finalExpr} AS ${outName}`);
  }

  // FROM + JOIN
  const fromParts: string[] = [];
  if (dim_table) {
    fromParts.push(`${dim_table} b`);
    if (useTargetWindow) fromParts.push(`CROSS JOIN tgt`);
  } else if (useTargetWindow) {
    fromParts.push(`tgt`);
  }

  const usedCtes = new Set(cteOf.values());
  const cteNames = [...usedCtes];
  if (dim_table && cteNames.length) {
    for (const cn of cteNames) {
      const on = useTargetWindow
        ? `${cn}.target_id = tgt.target_id AND ${cn}.${dimKey} = b.${dimKey}`
        : `${cn}.${dimKey} = b.${dimKey}`;
      fromParts.push(`LEFT JOIN ${cn} ON ${on}`);
    }
  } else if (cteNames.length) {
    fromParts.push(cteNames[0]);
    for (const cn of cteNames.slice(1)) {
      const on = useTargetWindow
        ? `${cn}.target_id = ${cteNames[0]}.target_id AND ${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`
        : `${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`;
      fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
    }
  }

  let sql = `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
${cteList.length ? `WITH ${cteList.join(',\n')}\n` : ''}`;

  if (total_row) {
    sql += `, brand_rows AS (
SELECT ${sel.join(',\n  ')}
FROM ${fromParts.join('\n')}
)
SELECT * FROM brand_rows
UNION ALL
SELECT tgt.target_id, '合计' AS ${dimKey}${dim_code === 'brand' && dim_table ? ', NULL AS brand_name' : ''}`;
    // 合计行指标列：SUM 各 base，rate 重算
    for (const code of metricCodes) {
      const m = metrics.find(x => x.metric_code === code)!;
      const outName = aliases?.[code] ?? code;
      if (m.measure_type === 'base') {
        const sumExpr = m.cost_sensitive
          ? `CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN SUM(brand_rows.${outName}) END`
          : `SUM(brand_rows.${outName})`;
        sql += `, ${sumExpr} AS ${outName}`;
      } else if (m.additive) {
        // additive derived：合计 = SUM(各加项) 运算 → 直接对展开式 SUM
        // 简化：用 brand_rows 已算列做 SUM 后重算
        sql += `, SUM(brand_rows.${outName}) AS ${outName}`;
      } else {
        // rate：合计行重算
        const formula = m.formula ?? '';
        const parts = formula.split('/').map(s => s.trim());
        if (parts.length === 2) {
          const numCode = aliases?.[parts[0]] ?? parts[0];
          const denCode = aliases?.[parts[1]] ?? parts[1];
          const rateExpr = `COALESCE(SUM(brand_rows.${numCode}), 0) / NULLIF(COALESCE(SUM(brand_rows.${denCode}), 0), 0)`;
          sql += `, ${maskCost(rateExpr, m)} AS ${outName}`;
        } else {
          sql += `, NULL AS ${outName}`;
        }
      }
    }
    sql += `\nFROM brand_rows${useTargetWindow ? ' JOIN tgt ON tgt.target_id = brand_rows.target_id' : ''}`;
    if (useTargetWindow) sql += `\nGROUP BY tgt.target_id`;
    sql += ';';
  } else {
    sql += `SELECT ${sel.join(',\n  ')}
FROM ${fromParts.join('\n')};`;
  }

  return sql;
}

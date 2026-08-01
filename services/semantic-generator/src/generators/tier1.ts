import { Metric, MetricSource, ViewConfig } from '../types';
import { astToSql, derivedExpr, classifyAst, type Ast, type AstCtx } from '../ast';

/**
 * Tier1 生成器（AST 化版）
 *
 * 能力：base 聚合 + derived（AST 翻译）+ cost脱敏
 *      + scope（目标日期窗口 + 考核战区）+ target 值 join + 合计行 + 维表 cross-join + 列别名
 *
 * 反自由发挥：derived 口径从 metric_registry.formula_ast 读，用 astToSql 递归翻译。
 *            生成器无字符串解析/无正则。round/COALESCE 格式在 derivedExpr（口径/格式分离）。
 */

type Ctx = AstCtx & { metrics: Metric[]; sources: MetricSource[] };

function baseRef(metric: Metric, ctx: Ctx): string {
  const cte = ctx.cteOf.get(metric.metric_code);
  if (!cte) throw new Error(`base metric ${metric.metric_code} 缺 CTE 映射`);
  return `${cte}.${metric.metric_code}`;
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

/** rate/remaining AST 取分子分母 ref code（合计行重算用） */
function rateOperands(ast: Ast): { num: string; den: Ast } | null {
  if (ast.t !== 'op' || ast.op !== '/') return null;
  if (ast.l.t !== 'ref') return null;
  return { num: ast.l.code, den: ast.r };
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
  const useTargetWindow = scope?.target_window ?? false;
  const useAssessed = scope?.assessed_war_zone ?? false;

  const leaves = collectLeaves(metricCodes, metrics);

  // 识别 daily 指标：formula_ast.t === 'filter' -> 在其 expr.ref 所属 base 的 actual CTE 产 FILTER 列
  const dailyMap = new Map<string, string>();   // baseMetricCode -> dailyMetricCode
  const dailyCodes = new Set<string>();
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m || m.measure_type !== 'derived' || !m.formula_ast) continue;
    if (m.formula_ast.t !== 'filter') continue;
    if (m.formula_ast.expr.t !== 'ref') continue;
    const baseCode = m.formula_ast.expr.code;
    dailyMap.set(baseCode, m.metric_code);
    dailyCodes.add(m.metric_code);
  }

  // base 叶子按 (source_table, source_filter) 分组；target_metric_values 单独走 target CTE
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

  // tgt CTE（目标窗口 + 窗口列，照手写视图 120 口径）
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
    // daily FILTER 列：仅 useTargetWindow 时（无窗口无 tgt.latest_day）
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
    const where: string[] = [];
    if (g.filter) where.push(g.filter);
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
  const ctx: Ctx = {
    metrics, sources, cteOf, useTargetWindow,
    derivedAst: (code) => metrics.find(m => m.metric_code === code)?.formula_ast ?? undefined,
    coalesceRefs: true,
  };
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
    const outName = aliases?.[code] ?? code;
    // daily 已在 actual CTE 聚合 -> SELECT 像 base 引用 cte 列
    const treatAsBase = m.measure_type === 'base' || dailyCodes.has(code);
    let expr: string;
    if (treatAsBase) {
      expr = baseRef(m, ctx);
    } else if (m.formula_ast) {
      expr = derivedExpr(m.formula_ast, ctx);
    } else {
      throw new Error(`derived metric ${code} 缺 formula_ast`);
    }
    sel.push(`${maskCost(expr, m)} AS ${outName}`);
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
    // 合计行：按 AST 分类重算
    for (const code of metricCodes) {
      const m = metrics.find(x => x.metric_code === code)!;
      const outName = aliases?.[code] ?? code;
      let sumExpr: string;
      if (m.measure_type === 'base') {
        sumExpr = `SUM(brand_rows.${outName})`;
      } else if (!m.formula_ast) {
        sumExpr = `NULL`;
      } else {
        const cls = classifyAst(m.formula_ast);
        if (cls === 'rate' || cls === 'remaining') {
          // rate/remaining 合计行重算：分子分母分别 SUM
          const operands = rateOperands(m.formula_ast);
          if (operands) {
            const numOut = aliases?.[operands.num] ?? operands.num;
            const numSum = `COALESCE(SUM(brand_rows.${numOut}), 0)`;
            const denExpr = cls === 'remaining'
              // remaining 分母是 greatest/nullif(total_days-days_elapsed,...)：合计行用 MAX(窗口列)
              ? astToSql(operands.den, { cteOf: new Map([['total_days', 'brand_rows'], ['days_elapsed', 'brand_rows']]), useTargetWindow: false })
              : `NULLIF(COALESCE(SUM(brand_rows.${aliases?.[rateDenRef(operands.den)] ?? rateDenRef(operands.den)}), 0), 0)`;
            sumExpr = cls === 'remaining'
              ? `round((${numSum} - 0) / ${denExpr}, 2)`  // remaining 分子是 (T-A)，需拆
              : `round(${numSum} / ${denExpr}, 4)`;
          } else {
            sumExpr = `NULL`;
          }
        } else {
          // additive/daily：可 SUM
          sumExpr = `SUM(brand_rows.${outName})`;
        }
      }
      sql += `, ${maskCost(sumExpr, m)} AS ${outName}`;
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

/** rate 分母若是 ref，取其 code（合计行 SUM 分母用） */
function rateDenRef(den: Ast): string {
  return den.t === 'ref' ? den.code : '';
}

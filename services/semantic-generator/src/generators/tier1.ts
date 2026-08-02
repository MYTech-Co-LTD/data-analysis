import { Metric, MetricSource, ViewConfig } from '../types';
import { astToSql, derivedExpr, classifyAst, type Ast, type AstCtx } from '../ast';
import { statusInClause } from '../sql-util';

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

  // extra_grain：额外 GROUP BY 的 fact 表列（带 s. 前缀），actual CTE 与 dimKey 并列 GROUP BY
  const extraGrainCols = config.extra_grain ?? [];
  // 去 s. 前缀作列名：'s.biz_date' -> 'biz_date'
  const egColName = (eg: string) => eg.replace(/^s\./, '');

  const dimKey = dim_code === 'brand' ? 'system_book_code'
    : dim_code === 'category' ? 'category_group'
    : dim_code === 'customer' ? 'client_code'
    : dim_code === 'item' ? 'item_num'
    : dim_code === 'date' ? 'biz_date'
    : 'branch_num';
  const useTargetWindow = scope?.target_window ?? false;
  const useAssessed = scope?.assessed_war_zone ?? false;
  const tgtLevel = scope?.target_level ?? 'total';
  const tgtStatusClause = statusInClause(scope?.target_status);
  // date grain 语义=时间序列罗列至当日（非全周期累计），join 上限用 latest_day；
  // extra_grain 含 biz_date（双 grain 时间序列，如客户×日期下钻）同此口径；其它维度保持 end_date
  const dateUpper = (dim_code === 'date' || extraGrainCols.includes('s.biz_date'))
    ? 'tgt.latest_day' : 'tgt.end_date';

  const leaves = collectLeaves(metricCodes, metrics);

  // category 维度：多表 UNION ALL 标志（delivery + wholesale）
  const isCategoryUnion = dim_code === 'category' &&
    new Set(leaves.map(l => sources.find(s => s.metric_code === l.metric_code)?.source_table)).size > 1;

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

  // base 叶子按 (effective source_table, source_filter) 分组；target_metric_values 单独走 target CTE
  // source_override：per-metric 重定向到粒度匹配聚合表（override 时丢弃原 source_filter，聚合表自洽）
  const actualGroups = new Map<string, { table: string; filter: string | null; metrics: Metric[] }>();
  const targetLeaves: Metric[] = [];
  for (const leaf of leaves) {
    const src = sources.find(s => s.metric_code === leaf.metric_code);
    if (!src) continue;
    if (src.source_table === 'target_metric_values') {
      targetLeaves.push(leaf);
      continue;
    }
    const ov = config.source_override?.[leaf.metric_code];
    const effTable = ov?.table ?? src.source_table;
    const effFilter = ov ? null : (src.source_filter ?? null);
    const key = `${effTable}|${effFilter ?? ''}`;
    if (!actualGroups.has(key)) actualGroups.set(key, { table: effTable, filter: effFilter, metrics: [] });
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
  FROM targets WHERE target_level='${tgtLevel}' AND ${tgtStatusClause}
)`);
  }

  // actual base CTE
  let cteIdx = 0;

  // category 维度 UNION ALL 特殊处理
  if (isCategoryUnion) {
    // 收集所有表的列：UNION ALL 需要对齐列结构
    const allBaseMetrics = [...actualGroups.values()].flatMap(g => g.metrics);

    // 生成每个表的单独 CTE
    const unionCteNames: string[] = [];
    for (const g of actualGroups.values()) {
      const cteName = `union${cteIdx++}`;
      unionCteNames.push(cteName);

      const joins: string[] = [];
      const where: string[] = [];
      if (g.filter) where.push(g.filter);
      if (useTargetWindow) {
        joins.push(`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND ${dateUpper}`);
      }
      if (useAssessed) {
        joins.push(`JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num`);
        where.push(`is_assessed_war_zone(db.first_level_region)`);
      }
      const whereClause = where.length ? `\n  WHERE ${where.join(' AND ')}` : '';
      const egSuffix = extraGrainCols.length ? `, ${extraGrainCols.join(', ')}` : '';
      const selectDims = useTargetWindow ? `tgt.target_id, s.${dimKey}${egSuffix}` : `s.${dimKey}${egSuffix}`;
      const groupDims = useTargetWindow ? `tgt.target_id, s.${dimKey}${egSuffix}` : `s.${dimKey}${egSuffix}`;

      // 该表的列（不需要对齐，各自 SUM）；source_override 列重定向
      const tableCols = g.metrics.map(m => {
        const src = sources.find(s => s.metric_code === m.metric_code)!;
        const ov = config.source_override?.[m.metric_code];
        const col = ov?.column ?? src.source_column;
        return `SUM(s.${col}) AS ${m.metric_code}`;
      });
      // daily 列
      if (useTargetWindow) {
        for (const m of g.metrics) {
          const dailyCode = dailyMap.get(m.metric_code);
          if (!dailyCode) continue;
          const src = sources.find(s => s.metric_code === m.metric_code)!;
          const ov = config.source_override?.[m.metric_code];
          const col = ov?.column ?? src.source_column;
          tableCols.push(`SUM(s.${col}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
        }
      }
      // carry_cols：源表列 MAX 带出
      if (config.carry_cols) {
        for (const col of config.carry_cols) {
          tableCols.push(`MAX(s.${col}) AS ${col}`);
        }
      }

      cteList.push(`${cteName} AS (
  SELECT ${selectDims},
    ${tableCols.join(',\n    ')}
  FROM ${g.table} s${joins.length ? '\n  ' + joins.join('\n  ') : ''}${whereClause}
  GROUP BY ${groupDims}
)`);
      // 注册该表包含的 metric
      for (const m of g.metrics) {
        cteOf.set(m.metric_code, cteName);
        const dailyCode = dailyMap.get(m.metric_code);
        if (dailyCode) cteOf.set(dailyCode, cteName);
      }
    }

    // 若有多个表，创建合并 CTE（UNION ALL + COALESCE 汇总）
    if (unionCteNames.length > 1) {
      const mergedCteName = `cte${cteIdx++}`;
      const selectParts: string[] = [];

      // SELECT 列表：维度 + 所有指标
      const egSelectCols = extraGrainCols.map(c => `${unionCteNames[0]}.${egColName(c)}`);
      const dimSelect = [
        useTargetWindow ? `${unionCteNames[0]}.target_id` : null,
        `${unionCteNames[0]}.${dimKey}`,
        ...egSelectCols,
      ].filter(Boolean).join(', ');

      const metricCols = allBaseMetrics.map(m => {
        const cteName = cteOf.get(m.metric_code);
        if (!cteName) return `NULL AS ${m.metric_code}`;
        return `${cteName}.${m.metric_code}`;
      });
      // daily 列
      if (useTargetWindow) {
        for (const m of allBaseMetrics) {
          const dailyCode = dailyMap.get(m.metric_code);
          if (!dailyCode) continue;
          const cteName = cteOf.get(m.metric_code);
          if (!cteName) {
            metricCols.push(`NULL AS ${dailyCode}`);
          } else {
            metricCols.push(`${cteName}.${dailyCode}`);
          }
        }
      }

      // FULL JOIN 多个 CTE
      const fromParts = [unionCteNames[0]];
      for (const cn of unionCteNames.slice(1)) {
        const egOnParts = extraGrainCols.map(c => `${cn}.${egColName(c)} = ${unionCteNames[0]}.${egColName(c)}`);
        const baseOn = useTargetWindow
          ? `${cn}.target_id = ${unionCteNames[0]}.target_id AND ${cn}.${dimKey} = ${unionCteNames[0]}.${dimKey}`
          : `${cn}.${dimKey} = ${unionCteNames[0]}.${dimKey}`;
        const on = egOnParts.length ? `${baseOn} AND ${egOnParts.join(' AND ')}` : baseOn;
        fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
      }

      cteList.push(`${mergedCteName} AS (
  SELECT ${dimSelect}, ${metricCols.join(', ')}
  FROM ${fromParts.join('\n  ')}
)`);
      // 更新 cteOf 指向合并 CTE
      for (const m of allBaseMetrics) {
        cteOf.set(m.metric_code, mergedCteName);
        const dailyCode = dailyMap.get(m.metric_code);
        if (dailyCode) cteOf.set(dailyCode, mergedCteName);
      }
    }
  } else {
    // 原有逻辑：单表单 CTE
    for (const g of actualGroups.values()) {
      const cteName = `cte${cteIdx++}`;
      const cols = g.metrics.map(m => {
        const src = sources.find(s => s.metric_code === m.metric_code)!;
        const ov = config.source_override?.[m.metric_code];
        const col = ov?.column ?? src.source_column;
        return `SUM(s.${col}) AS ${m.metric_code}`;
      });
      // daily FILTER 列：仅 useTargetWindow 时（无窗口无 tgt.latest_day）；source_override 列重定向
      if (useTargetWindow) {
        for (const m of g.metrics) {
          const dailyCode = dailyMap.get(m.metric_code);
          if (!dailyCode) continue;
          const src = sources.find(s => s.metric_code === m.metric_code)!;
          const ov = config.source_override?.[m.metric_code];
          const col = ov?.column ?? src.source_column;
          cols.push(`SUM(s.${col}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dailyCode}`);
        }
      }
      // dim_grain：extra 列追加（非分组 dim 列，功能依赖于 grain key，MAX 安全）
      if (config.dim_grain?.extra) {
        const alias = config.dim_grain.table.split(' ')[1]; // 'di'
        for (const ex of config.dim_grain.extra) {
          cols.push(`MAX(${alias}.${ex}) AS ${ex}`);
        }
      }
      // carry_cols：源表列 MAX 带出
      if (config.carry_cols) {
        for (const col of config.carry_cols) {
          cols.push(`MAX(s.${col}) AS ${col}`);
        }
      }
      const colsStr = cols.join(',\n    ');

      const joins: string[] = [];
      const where: string[] = [];
      // dim_grain：actual CTE 加 dim join + grain 变换（替换 s.${dimKey}）
      const dimAlias = config.dim_grain?.table.split(' ')[1];
      const grainCol = config.dim_grain ? `${dimAlias}.${config.dim_grain.key}` : `s.${dimKey}`;
      if (g.filter) where.push(g.filter);
      if (config.dim_grain) {
        if (config.dim_grain.lateral_pick) {
          // 跨账套回退匹配：本账套优先、跨品牌回退（如 64188 批发卖 3120 货），LIMIT 1 防 item_num 重叠翻倍
          const lpTbl = config.dim_grain.table.split(' ')[0]; // 'dim_item'
          const lpAlias = config.dim_grain.table.split(' ')[1]; // 'di'
          const lp = config.dim_grain.lateral_pick;
          joins.push(`JOIN LATERAL (SELECT * FROM ${lpTbl} WHERE ${lp.match} ORDER BY (${lp.prefer_own}) DESC LIMIT 1) ${lpAlias} ON true`);
        } else {
          joins.push(`JOIN ${config.dim_grain.table} ON ${config.dim_grain.on}`);
        }
      }
      let selectDims = grainCol;
      let groupDims = grainCol;
      if (useTargetWindow) {
        joins.push(`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND ${dateUpper}`);
        selectDims = `tgt.target_id, ${grainCol}`;
        groupDims = `tgt.target_id, ${grainCol}`;
      }
      // extra_grain：fact 表列追加到 actual CTE SELECT + GROUP BY（与 grainCol 并列，实现双 grain）
      if (extraGrainCols.length) {
        const egS = `, ${extraGrainCols.join(', ')}`;
        selectDims += egS;
        groupDims += egS;
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
  WHERE t.breakdown_level='${config.target_breakdown ?? 'store'}' AND ${metricFilter || 'true'}${assessedCond}
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
  // 多 CTE FULL JOIN 时，维度列/键/target_id 须 COALESCE 跨 CTE；否则只从 firstCte 取会丢另一侧 only 行
  // （如 item 视图：有出库无销售的商品只在 cte1，旧实现从 cte0 取键 → target_id/category_group NULL 被丢）
  const uniqCtes = [...new Set(cteOf.values())];
  const refCol = (col: string) =>
    uniqCtes.length > 1
      ? `COALESCE(${uniqCtes.map((c) => `${c}.${col}`).join(', ')})`
      : `${uniqCtes[0]}.${col}`;

  // 维度列
  if (useTargetWindow) {
    // category 维度（UNION ALL）从合并 CTE 选
    if (isCategoryUnion) {
      const mergedCte = [...new Set(cteOf.values())][0];
      sel.push(`${mergedCte}.target_id`);
    } else if (dim_table) {
      // dim_table 路径：tgt 在 FROM（CROSS JOIN tgt），tgt.target_id 恒在
      sel.push(`tgt.target_id`);
    } else {
      // dim_grain 或纯 CTE 路径：tgt 不在 final FROM（只在 actual CTE 内 JOIN），
      // actual CTE 已 SELECT target_id，多 CTE 时 COALESCE 跨 CTE（表达式须显式 AS target_id 命名）
      sel.push(`${refCol('target_id')} AS target_id`);
    }
  }
  if (config.dim_grain) {
    // dim_grain：维度列从 actual CTE 选（actual CTE 已含 key + extra），多 CTE 时 COALESCE 跨 CTE
    sel.push(`${refCol(config.dim_grain.key)} AS ${config.dim_grain.key}`);
    if (config.dim_grain.extra) {
      for (const ex of config.dim_grain.extra) {
        sel.push(`${refCol(ex)} AS ${ex}`);
      }
    }
  } else if (dim_table) {
    sel.push(`b.${dimKey} AS ${dimKey}`);
    if (dim_code === 'brand' && dim_table) sel.push(`b.brand_name`);
  } else if (useTargetWindow) {
    // category 维度（UNION ALL）直接从 CTE 选，不经过 dim_table
    const firstCte = [...new Set(cteOf.values())][0];
    sel.push(`${firstCte}.${dimKey} AS ${dimKey}`);
  } else {
    sel.push(`${dimKey} AS ${dimKey}`);
  }

  // extra_grain：actual CTE 已 GROUP BY 这些 fact 表列，final SELECT 从 CTE 输出（去 s. 前缀作列名），多 CTE 时 COALESCE
  if (extraGrainCols.length) {
    for (const eg of extraGrainCols) {
      const colName = egColName(eg);
      sel.push(`${refCol(colName)} AS ${colName}`);
    }
  }

  // carry_cols：从 CTE 选，多 CTE 时 COALESCE
  if (config.carry_cols) {
    for (const col of config.carry_cols) {
      sel.push(`${refCol(col)} AS ${col}`);
    }
  }

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

  // extra_join：标量子查询补列（避 LEFT JOIN 翻倍）
  if (config.extra_join) {
    const ejFirstCte = [...new Set(cteOf.values())][0];
    const joinAlias = config.extra_join.table.split(' ')[1];
    for (const c of config.extra_join.cols) {
      sel.push(`(SELECT ${c.expr} FROM ${config.extra_join.table} WHERE ${joinAlias}.${config.extra_join.on.right} = ${ejFirstCte}.${config.extra_join.on.left} LIMIT 1) AS ${c.out}`);
    }
  }

  // FROM + JOIN
  const fromParts: string[] = [];
  const usedCtes = new Set(cteOf.values());
  const cteNames = [...usedCtes];
  if (config.dim_grain) {
    // dim_grain：无 dim_table cross-join，actual CTE 之间 FULL JOIN ON dim_grain.key
    fromParts.push(cteNames[0]);
    for (const cn of cteNames.slice(1)) {
      const egOnParts = extraGrainCols.map(c => `${cn}.${egColName(c)} = ${cteNames[0]}.${egColName(c)}`);
      const baseOn = useTargetWindow
        ? `${cn}.target_id = ${cteNames[0]}.target_id AND ${cn}.${config.dim_grain.key} = ${cteNames[0]}.${config.dim_grain.key}`
        : `${cn}.${config.dim_grain.key} = ${cteNames[0]}.${config.dim_grain.key}`;
      const on = egOnParts.length ? `${baseOn} AND ${egOnParts.join(' AND ')}` : baseOn;
      fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
    }
  } else if (dim_table) {
    fromParts.push(`${dim_table} b`);
    if (useTargetWindow) fromParts.push(`CROSS JOIN tgt`);
    for (const cn of cteNames) {
      const on = useTargetWindow
        ? `${cn}.target_id = tgt.target_id AND ${cn}.${dimKey} = b.${dimKey}`
        : `${cn}.${dimKey} = b.${dimKey}`;
      fromParts.push(`LEFT JOIN ${cn} ON ${on}`);
    }
  } else {
    // dim_grain-less/dim_table-less：actual CTE 已带 target_id，final SELECT 引用 cte.target_id
    // （上面维度列块已切到 firstCte.target_id），tgt 不进 final FROM（避免 FROM tgt cte0 别名陷阱）
    if (cteNames.length) {
      fromParts.push(cteNames[0]);
      for (const cn of cteNames.slice(1)) {
        const egOnParts = extraGrainCols.map(c => `${cn}.${egColName(c)} = ${cteNames[0]}.${egColName(c)}`);
        const baseOn = useTargetWindow
          ? `${cn}.target_id = ${cteNames[0]}.target_id AND ${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`
          : `${cn}.${dimKey} = ${cteNames[0]}.${dimKey}`;
        const on = egOnParts.length ? `${baseOn} AND ${egOnParts.join(' AND ')}` : baseOn;
        fromParts.push(`FULL OUTER JOIN ${cn} ON ${on}`);
      }
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

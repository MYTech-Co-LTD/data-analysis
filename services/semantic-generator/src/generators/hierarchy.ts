import { Metric, MetricSource, ViewConfig, HierarchyLevel } from '../types';
import { astToSql, derivedExpr, classifyAst, type Ast, type AstCtx } from '../ast';

/**
 * 层级视图生成器（T6：final SELECT + 各级 UNION ALL）
 *
 * 能力：按 hierarchy 配置找到 is_leaf level，产出叶级 grain 上的
 *      actual + target + daily 聚合，汇总为 leaf_rows CTE
 *      （叶级粒度上挂 actual/target/窗口列，COALESCE 补 0）。
 *      T5：在每个父级 level（is_leaf=false）上，从 leaf_rows 做 actual rollup
 *      （SUM additive + MAX 窗口），并按 target_breakdown 产父级 target CTE。
 *      维护 levelCtes: Map<level, {act, tgt, grain}> 供 T6 各级 UNION ALL。
 *      T6：对每级生成 SELECT（target_id/level/parent_code + 合并维度列 + 指标列），
 *          各级 UNION ALL。指标列含 base actual/target 引用、daily 引用、
 *          rate 重算（actual/nullif(target,0)）、remaining 重算（窗口列）。
 *
 * 结构（照手写视图 120 的 store_tgt / sale_act / store_rows + region_rows / region_tgt
 *      + 末段 all_rows UNION ALL + 最终 SELECT 列加工）：
 *   WITH tgt AS (active total target 日期窗口 + 窗口列),
 *        leaf_act_N AS (base 表按叶级 grain + tgt 窗口 + assessed 聚合，含 daily FILTER),
 *        leaf_tgt AS (target_metric_values 按 leaf.target_breakdown + 叶级 grain 聚合),
 *        leaf_rows AS (tgt ⊥ dim_branch LEFT JOIN 各 actual/target + COALESCE + 窗口列
 *                      + 补齐父级 grain 依赖的维度列),
 *        <parent>_act AS (从 leaf_rows 按 pgrain SUM actual/daily + MAX 窗口),
 *        <parent>_tgt AS (target_metric_values 按 p.target_breakdown 聚合，不 join dim_branch)
 *   <各级 SELECT UNION ALL>
 *
 * 门店键铁律：store 级 grain 必含 (system_book_code, branch_num) 复合键，
 *            禁 branch_num 单独 join。
 */

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

export function generateHierarchyView(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const { view_name, metrics: metricCodes, scope, hierarchy } = config;
  const useAssessed = scope?.assessed_war_zone ?? false;
  const tgtLevel = scope?.target_level ?? 'total';
  const tgtStatus = scope?.target_status ?? 'active';

  // Category dimension: special handling (pseudo-hierarchy with categories + total)
  if (config.dim_code === 'category') {
    return generateCategoryView(config, metrics, sources);
  }

  const leaf = hierarchy?.find(h => h.is_leaf);
  if (!leaf) {
    throw new Error('generateHierarchyView: hierarchy 配置缺 is_leaf level');
  }
  const parentLevels = (hierarchy ?? []).filter(h => !h.is_leaf); // T5: 父级（sub_region/region）
  const grain = leaf.grain;                        // ['system_book_code','branch_num']
  const grainS = grain.map(g => `s.${g}`).join(', '); // source 表别名前缀
  const grainT = grain.map(g => `t.${g}`).join(', '); // targets 表别名前缀

  const leaves = collectLeaves(metricCodes, metrics);

  // daily 指标识别：derived + formula 含 FILTER(biz_date=latest_day)
  // → 在其 depends_on[0] 的所有叶 base 的 actual CTE 里产 FILTER(latest_day) 列
  // daily-of-derived：depends_on[0] 若是 additive derived（如 distribution_amount），
  //   解析到其全部叶 base（delivery_amount + wholesale_pp_amount），各 CTE 产 FILTER 列，daily 值 = 各列之和
  const dailyBases = new Map<string, string[]>();   // dailyCode → 依赖的叶 baseCode 列表
  const dailyFeeds = new Map<string, string[]>();   // dailyCode → 实际产 FILTER 列的 CTE 名列表（leaf_act_N）
  for (const code of metricCodes) {
    const m = metrics.find(x => x.metric_code === code);
    if (!m || m.measure_type !== 'derived' || !m.formula_ast) continue;
    if (m.formula_ast.t !== 'filter') continue;
    const exprAst = m.formula_ast.expr;
    let bases: string[] = [];
    if (exprAst.t === 'ref') {
      const targetMetric = metrics.find(x => x.metric_code === exprAst.code);
      if (targetMetric) {
        bases = targetMetric.measure_type === 'base'
          ? [exprAst.code]
          : collectLeaves([exprAst.code], metrics).map(x => x.metric_code);
      }
    }
    dailyBases.set(code, bases);
    dailyFeeds.set(code, []);
  }

  // base 叶子按 (source_table, source_filter) 分组；target_metric_values 单独走 target CTE
  const actualGroups = new Map<string, { table: string; filter: string | null; metrics: Metric[] }>();
  const targetLeaves: Metric[] = [];
  for (const lf of leaves) {
    const src = sources.find(s => s.metric_code === lf.metric_code);
    if (!src) continue;
    if (src.source_table === 'target_metric_values') {
      targetLeaves.push(lf);
      continue;
    }
    const key = `${src.source_table}|${src.source_filter ?? ''}`;
    if (!actualGroups.has(key)) actualGroups.set(key, { table: src.source_table, filter: src.source_filter, metrics: [] });
    actualGroups.get(key)!.metrics.push(lf);
  }

  const cteList: string[] = [];
  const cteOf = new Map<string, string>();          // metricCode(base+daily+target) → cteName

  // 1. tgt CTE —— hierarchy 视图依赖 target_id 关联 + 窗口列，始终构建
  //    （照 120：active total target 的日期窗口 + total_days/days_elapsed/latest_day）
  cteList.push(`tgt AS (
  SELECT id AS target_id, start_date, end_date,
    (end_date - start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, end_date) - start_date + 1, 0) AS days_elapsed,
    LEAST(current_date, end_date) AS latest_day
  FROM targets WHERE target_level='${tgtLevel}' AND status='${tgtStatus}'
)`);

  // 2. 叶级 actual CTE：按 grain 聚合 base + daily FILTER，scope 日期窗口 + assessed
  let actIdx = 0;
  for (const g of actualGroups.values()) {
    const cteName = `leaf_act_${actIdx++}`;
    const cols = g.metrics.map(m => {
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      return `SUM(s.${src.source_column}) AS ${m.metric_code}`;
    });
    // daily FILTER 列：遍历 dailyBases，该 base 是某 daily 的依赖叶 → 产 FILTER 列
    const dailyInThisCte = new Set<string>();
    for (const m of g.metrics) {
      const src = sources.find(s => s.metric_code === m.metric_code)!;
      for (const [dc, bases] of dailyBases) {
        if (bases.includes(m.metric_code) && !dailyInThisCte.has(dc)) {
          cols.push(`SUM(s.${src.source_column}) FILTER (WHERE s.biz_date = tgt.latest_day) AS ${dc}`);
          dailyInThisCte.add(dc);
          dailyFeeds.get(dc)!.push(cteName);
        }
      }
    }
    const colsStr = cols.join(',\n    ');

    const joins: string[] = [`JOIN tgt ON s.biz_date BETWEEN tgt.start_date AND tgt.end_date`];
    const where: string[] = [];
    if (g.filter) where.push(g.filter);
    if (useAssessed) {
      // 复合门店键 join dim_branch（禁 branch_num 单独 join）
      joins.push(`JOIN dim_branch db ON db.system_book_code = s.system_book_code AND db.branch_num = s.branch_num`);
      where.push(`is_assessed_war_zone(db.first_level_region)`);
    }
    const whereClause = where.length ? `\n  WHERE ${where.join(' AND ')}` : '';

    cteList.push(`${cteName} AS (
  SELECT tgt.target_id, ${grainS},
    ${colsStr}
  FROM ${g.table} s
  ${joins.join('\n  ')}${whereClause}
  GROUP BY tgt.target_id, ${grainS}
)`);
    for (const m of g.metrics) {
      cteOf.set(m.metric_code, cteName);
    }
  }

  // 3. 叶级 target CTE：target_metric_values 按 leaf.target_breakdown + 叶级 grain 聚合
  //    照 120 store_tgt：MAX(target_value) FILTER (WHERE metric_code=...)，多 target 指标合一 CTE
  if (targetLeaves.length > 0) {
    const tgtCols = targetLeaves.map(tl => {
      const src = sources.find(s => s.metric_code === tl.metric_code)!;
      const f = src.source_filter ?? 'true';
      return `MAX(tmv.target_value) FILTER (WHERE ${f}) AS ${tl.metric_code}`;
    });
    // JOIN 条件：OR 合并各 target 指标的 source_filter
    const metricFilters = targetLeaves.map(tl => {
      const src = sources.find(s => s.metric_code === tl.metric_code)!;
      return src.source_filter ?? 'true';
    }).join(' OR ');

    const joins: string[] = [];
    const whereExtra: string[] = [`t.branch_num <> 'ALL'`];
    if (useAssessed) {
      joins.push(`JOIN dim_branch db ON db.system_book_code = t.system_book_code AND db.branch_num = t.branch_num`);
      whereExtra.push(`is_assessed_war_zone(db.first_level_region)`);
    }

    cteList.push(`leaf_tgt AS (
  SELECT t.parent_target_id AS target_id, ${grainT},
    ${tgtCols.join(',\n    ')}
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (${metricFilters})${joins.length ? '\n  ' + joins.join('\n  ') : ''}
  WHERE t.breakdown_level = '${leaf.target_breakdown}' AND ${whereExtra.join(' AND ')}
  GROUP BY t.parent_target_id, ${grainT}
)`);
    for (const tl of targetLeaves) cteOf.set(tl.metric_code, 'leaf_tgt');
  }

  // 4. leaf_rows CTE：tgt ⊥ dim_branch + LEFT JOIN 各 actual/target + COALESCE + 窗口列
  //    照 120 store_rows；门店键复合 (system_book_code, branch_num)
  const usedCtes = [...new Set(cteOf.values())];
  const cteAlias = new Map<string, string>();
  const leftJoins: string[] = [];
  usedCtes.forEach((cn, i) => {
    const al = `a${i}`;
    cteAlias.set(cn, al);
    const onParts = [`${al}.target_id = tgt.target_id`, ...grain.map(g => `${al}.${g} = db.${g}`)];
    leftJoins.push(`LEFT JOIN ${cn} ${al} ON ${onParts.join(' AND ')}`);
  });

  // 收集所有需 COALESCE 的指标列（actual base + daily + target），保留 metrics 配置顺序
  // daily 列可能由多个 actual CTE 供数（daily-of-derived），用 ctes 数组记录全部供数 CTE
  const metricCols: { code: string; ctes: string[]; isDaily: boolean }[] = [];
  const seen = new Set<string>();
  for (const g of actualGroups.values()) {
    for (const m of g.metrics) {
      if (!seen.has(m.metric_code)) {
        metricCols.push({ code: m.metric_code, ctes: [cteOf.get(m.metric_code)!], isDaily: false });
        seen.add(m.metric_code);
      }
    }
  }
  for (const dc of dailyBases.keys()) {
    if (!seen.has(dc)) {
      metricCols.push({ code: dc, ctes: dailyFeeds.get(dc)!, isDaily: true });
      seen.add(dc);
    }
  }
  for (const tl of targetLeaves) {
    if (!seen.has(tl.metric_code)) {
      metricCols.push({ code: tl.metric_code, ctes: ['leaf_tgt'], isDaily: false });
      seen.add(tl.metric_code);
    }
  }

  const sel: string[] = [];
  const selOuts = new Set<string>();   // 去重：grain 暴露列与 leaf.columns 重叠时跳过（避免 duplicate column）
  sel.push(`tgt.target_id`);
  selOuts.add('target_id');
  sel.push(`'${leaf.level}' AS level`);
  selOuts.add('level');
  for (const g of grain) {
    sel.push(`db.${g} AS ${g}`);
    selOuts.add(g);
  }
  // leaf.columns 输出维度列（来自 dim_branch，expr 无前缀时补 db.）
  for (const col of leaf.columns) {
    if (selOuts.has(col.out)) continue;   // grain 已暴露（如 branch_num）→ 跳过避免重复
    const expr = col.expr.includes('.') ? col.expr : `db.${col.expr}`;
    sel.push(`${expr} AS ${col.out}`);
    selOuts.add(col.out);
  }
  // T5: 补齐父级 rollup 依赖的维度列 —— leaf.columns 未暴露的父级 grain 列，
  //     从父级 level.columns 取 expr 映射（照 120 store_rows 行 85 暴露 war_zone/region_l2）
  const leafOuts = selOuts;  // alias：已含 grain + leaf.columns 的 out
  const extraParentDims: { out: string; expr: string }[] = [];
  for (const p of parentLevels) {
    for (const g of p.grain) {
      if (!leafOuts.has(g) && !extraParentDims.find(x => x.out === g)) {
        const pcol = p.columns.find(c => c.out === g);
        if (!pcol) {
          throw new Error(
            `generateHierarchyView: 父级 ${p.level} grain '${g}' 未在 leaf.columns 或 ${p.level}.columns 提供映射，无法 rollup`);
        }
        extraParentDims.push(pcol);
      }
    }
  }
  for (const col of extraParentDims) {
    const expr = col.expr.includes('.') ? col.expr : `db.${col.expr}`;
    sel.push(`${expr} AS ${col.out}`);
    selOuts.add(col.out);
  }
  for (const mc of metricCols) {
    if (mc.isDaily) {
      // daily：多 CTE 供数时求和（daily-of-derived，如 daily_delivery = 调拨daily + 批发daily）
      const alList = mc.ctes.map(cn => cteAlias.get(cn)!);
      const sumExpr = alList.length > 1
        ? alList.map(al => `COALESCE(${al}.${mc.code}, 0)`).join(' + ')
        : `COALESCE(${alList[0]}.${mc.code}, 0)`;
      sel.push(`${sumExpr} AS ${mc.code}`);
    } else {
      const al = cteAlias.get(mc.ctes[0])!;
      sel.push(`COALESCE(${al}.${mc.code}, 0) AS ${mc.code}`);
    }
  }
  sel.push(`tgt.total_days`);
  sel.push(`tgt.days_elapsed`);

  const whereParts = [`db.is_active`, `db.branch_num <> '99'`];
  if (useAssessed) whereParts.push(`is_assessed_war_zone(db.first_level_region)`);

  cteList.push(`leaf_rows AS (
  SELECT ${sel.join(',\n  ')}
  FROM tgt CROSS JOIN dim_branch db
  ${leftJoins.join('\n  ')}
  WHERE ${whereParts.join(' AND ')}
)`);

  // 5. T5 父级 actual rollup + 父级 target CTE
  //    照 120 region_rows/wz_rows（actual rollup）与 region_tgt/wz_tgt（父级 target）
  //    维护 levelCtes 供 T6 各级 UNION ALL 与列加工
  const levelCtes = new Map<string, { act: string; tgt: string | null; grain: string[] }>();
  levelCtes.set(leaf.level, {
    act: 'leaf_rows',
    tgt: targetLeaves.length > 0 ? 'leaf_tgt' : null,
    grain: leaf.grain,
  });

  for (const p of parentLevels) {
    const pgrain = p.grain;

    // 5a. 父级 actual rollup CTE：从 leaf_rows 按 pgrain SUM additive actual/daily + MAX 窗口列
    //     target 列不 rollup（父级 target 由 5b 独立 CTE 给）
    const actCteName = `${p.level}_act`;
    const actCols = metricCols
      .filter(mc => mc.ctes[0] !== 'leaf_tgt')
      .map(mc => `SUM(${mc.code}) AS ${mc.code}`);
    actCols.push('MAX(total_days) AS total_days', 'MAX(days_elapsed) AS days_elapsed');
    cteList.push(`${actCteName} AS (
  SELECT target_id, ${pgrain.join(', ')},
    ${actCols.join(',\n    ')}
  FROM leaf_rows
  GROUP BY target_id, ${pgrain.join(', ')}
)`);

    // 5b. 父级 target CTE：target_metric_values 按 p.target_breakdown 聚合
    //     targets 表自带 war_zone/region_l2 列，不 join dim_branch（照 120 region_tgt/wz_tgt）
    let tgtCteName: string | null = null;
    if (targetLeaves.length > 0) {
      tgtCteName = `${p.level}_tgt`;
      const tgtCols = targetLeaves.map(tl => {
        const src = sources.find(s => s.metric_code === tl.metric_code)!;
        const f = src.source_filter ?? 'true';
        return `MAX(tmv.target_value) FILTER (WHERE ${f}) AS ${tl.metric_code}`;
      });
      const metricFilters = targetLeaves.map(tl => {
        const src = sources.find(s => s.metric_code === tl.metric_code)!;
        return src.source_filter ?? 'true';
      }).join(' OR ');
      const grainT2 = pgrain.map(g => `t.${g}`).join(', ');
      const whereExtra: string[] = [`t.breakdown_level = '${p.target_breakdown}'`];
      // 考核过滤：targets 表 war_zone 列恒在（breakdown_level 为 war_zone/region_l2 的行均带 war_zone）
      if (useAssessed) whereExtra.push(`is_assessed_war_zone(t.war_zone)`);
      cteList.push(`${tgtCteName} AS (
  SELECT t.parent_target_id AS target_id, ${grainT2},
    ${tgtCols.join(',\n    ')}
  FROM targets t
  JOIN target_metric_values tmv ON tmv.target_id = t.id AND (${metricFilters})
  WHERE ${whereExtra.join(' AND ')}
  GROUP BY t.parent_target_id, ${grainT2}
)`);
    }
    levelCtes.set(p.level, { act: actCteName, tgt: tgtCteName, grain: pgrain });
  }

  // 6. T6 final SELECT：对每级生成 SELECT（target_id/level/parent_code + 合并维度列 + 指标列），
  //    各级 UNION ALL。指标列含 base actual/target 引用、daily 引用、rate 重算、remaining 重算。
  //    照 120 末段 all_rows UNION ALL + 最终 SELECT 列加工（rate/remaining/daily）。
  const sql = buildFinalSelect(config, metrics, hierarchy ?? [], levelCtes, targetLeaves, cteList, view_name);
  return sql;
}

/**
 * Category dimension view generator (pseudo-hierarchy: categories + total)
 *
 * Category is not a true hierarchy - it's a flat dimension with individual categories
 * (水果/标品/耗材) plus a total row. Actuals come from delivery + wholesale UNION ALL.
 *
 * 反自由发挥约束（迁移 133）：
 * - 类别值从 config.categories 读取（不硬编码）
 * - 表名从 metric_sources 读取（delivery_amount → delivery, wholesale_amount → wholesale）
 * - 指标码从 config.metrics 读取（不硬编码 'outbound_amt'）
 *
 * Structure (照手写视图 095):
 *   WITH target_base AS (active total target 日期窗口 + system_book_code),
 *        outbound_amt_targets AS (target_metric_values WHERE metric_code='outbound_amt'),
 *        outbound_profit_targets AS (target_metric_values WHERE metric_code='outbound_profit'),
 *        delivery_actuals AS (delivery 按 category_group 聚合),
 *        wholesale_actuals AS (wholesale 按 category_group 聚合),
 *        category_actuals AS (delivery UNION ALL wholesale),
 *        category_level AS (categories CROSS JOIN targets LEFT JOIN actuals/targets),
 *        total_level AS (SUM rollup + 重算 derived)
 *   SELECT 14 columns FROM category_level UNION ALL SELECT 14 columns FROM total_level
 */
function generateCategoryView(
  config: ViewConfig,
  metrics: Metric[],
  sources: MetricSource[]
): string {
  const { view_name, scope, categories } = config;
  const tgtLevel = scope?.target_level ?? 'total';
  const tgtStatus = scope?.target_status ?? 'active';

  // 反自由发挥：类别值从配置读取，不硬编码
  const categoryValues = categories ?? ['水果', '标品', '耗材'];
  const categoryList = categoryValues.map(c => `('${c}')`).join(', ');

  // 反自由发挥：从 metric_sources 读取表名（delivery_amount/profit → delivery, wholesale_amount/profit → wholesale）
  const deliverySrc = sources.find(s => s.metric_code === 'delivery_amount');
  const wholesaleSrc = sources.find(s => s.metric_code === 'wholesale_amount');
  if (!deliverySrc || !wholesaleSrc) {
    throw new Error('generateCategoryView: 缺少 delivery_amount 或 wholesale_amount 的 metric_sources 映射');
  }
  const deliveryTable = deliverySrc.source_table;
  const wholesaleTable = wholesaleSrc.source_table;

  // 指标码从 config.metrics 读取（不硬编码 'outbound_amt'/'outbound_profit'）
  // 假设 config.metrics[0] = outbound_amount (金额), config.metrics[1] = outbound_profit (毛利)
  const amountMetric = config.metrics[0] ?? 'outbound_amount';
  const profitMetric = config.metrics[1] ?? 'outbound_profit';

  const cteList: string[] = [];

  // 1. target_base CTE - date window + system_book_code (照 095 行 14-24)
  cteList.push(`target_base AS (
  SELECT
    t.id AS target_id,
    t.system_book_code,
    t.start_date,
    t.end_date,
    (t.end_date - t.start_date + 1) AS total_days,
    GREATEST(LEAST(current_date, t.end_date) - t.start_date + 1, 0) AS days_elapsed
  FROM targets t
  WHERE t.status = '${tgtStatus}' AND t.target_level = '${tgtLevel}' AND t.category IS NULL
)`);

  // 2. Target CTEs: outbound_amt_targets, outbound_profit_targets (照 095 行 25-32)
  // 指标码从变量读取（反自由发挥）
  cteList.push(`outbound_amt_targets AS (
  SELECT tmv.target_id, tmv.target_value AS sale_target
  FROM target_metric_values tmv WHERE tmv.metric_code = '${amountMetric}'
)`);

  cteList.push(`outbound_profit_targets AS (
  SELECT tmv.target_id, tmv.target_value AS profit_target
  FROM target_metric_values tmv WHERE tmv.metric_code = '${profitMetric}'
)`);

  // 3. Category actuals: delivery + wholesale (照 095 行 35-60)
  // 表名从 metric_sources 读取，类别值从配置读取（反自由发挥）
  cteList.push(`delivery_actuals AS (
  SELECT
    tb.target_id,
    d.category_group AS category,
    SUM(d.out_money) AS sale_actual,
    SUM(d.profit_money) AS profit_actual,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.out_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN d.biz_date = tb.start_date + tb.days_elapsed - 1 THEN d.profit_money ELSE 0 END) AS daily_profit
  FROM ${deliveryTable} d
  JOIN target_base tb ON d.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR d.system_book_code = tb.system_book_code)
    AND d.category_group IN (${categoryValues.map(c => `'${c}'`).join(', ')})
  GROUP BY tb.target_id, d.category_group
)`);

  cteList.push(`wholesale_actuals AS (
  SELECT
    tb.target_id,
    w.category_group AS category,
    SUM(w.wholesale_money) AS sale_actual,
    SUM(w.wholesale_profit) AS profit_actual,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_money ELSE 0 END) AS daily_amount,
    SUM(CASE WHEN w.biz_date = tb.start_date + tb.days_elapsed - 1 THEN w.wholesale_profit ELSE 0 END) AS daily_profit
  FROM ${wholesaleTable} w
  JOIN target_base tb ON w.biz_date BETWEEN tb.start_date AND tb.end_date
  WHERE (tb.system_book_code = 'ALL' OR w.system_book_code = tb.system_book_code)
    AND w.category_group IN (${categoryValues.map(c => `'${c}'`).join(', ')})
  GROUP BY tb.target_id, w.category_group
)`);

  // 4. Merge delivery + wholesale (照 095 行 33-61)
  cteList.push(`category_actuals AS (
  SELECT
    COALESCE(d.target_id, w.target_id) AS target_id,
    COALESCE(d.category, w.category) AS category,
    COALESCE(d.sale_actual, 0) + COALESCE(w.sale_actual, 0) AS sale_actual,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(d.profit_actual, 0) + COALESCE(w.profit_actual, 0) END AS profit_actual,
    COALESCE(d.daily_amount, 0) + COALESCE(w.daily_amount, 0) AS daily_amount,
    CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN COALESCE(d.daily_profit, 0) + COALESCE(w.daily_profit, 0) END AS daily_profit
  FROM delivery_actuals d
  FULL OUTER JOIN wholesale_actuals w ON w.target_id = d.target_id AND w.category = d.category
)`);

  // 5. category_level CTE: individual categories (照 095 行 62-86)
  // 类别值从配置读取（反自由发挥）
  cteList.push(`category_level AS (
  SELECT
    tb.target_id,
    ca.category,
    COALESCE(oat.sale_target, 0) AS sale_target,
    ca.sale_actual,
    CASE WHEN oat.sale_target > 0 THEN ROUND(ca.sale_actual / oat.sale_target, 4) ELSE NULL END AS sale_rate,
    COALESCE(opt.profit_target, 0) AS profit_target,
    ca.profit_actual,
    CASE WHEN opt.profit_target > 0 THEN ROUND(ca.profit_actual / opt.profit_target, 4) ELSE NULL END AS profit_rate,
    CASE WHEN ca.sale_actual > 0 THEN ROUND(ca.profit_actual / ca.sale_actual, 4) ELSE NULL END AS profit_margin,
    ca.daily_amount,
    ca.daily_profit,
    CASE WHEN ca.daily_amount > 0 THEN ROUND(ca.daily_profit / ca.daily_amount, 4) ELSE NULL END AS daily_profit_margin,
    CASE
      WHEN tb.days_elapsed < tb.total_days AND opt.profit_target > 0
      THEN ROUND((opt.profit_target - ca.profit_actual) / (tb.total_days - tb.days_elapsed), 2)
      ELSE 0
    END AS remaining_daily_profit_target
  FROM target_base tb
  CROSS JOIN (VALUES ${categoryList}) AS cats(category)
  LEFT JOIN outbound_amt_targets oat ON oat.target_id = tb.target_id
  LEFT JOIN outbound_profit_targets opt ON opt.target_id = tb.target_id
  LEFT JOIN category_actuals ca ON ca.target_id = tb.target_id AND ca.category = cats.category
)`);

  // 6. total_level CTE: aggregate (照 095 行 87-104)
  cteList.push(`total_level AS (
  SELECT
    target_id,
    '合计' AS category,
    SUM(sale_target) AS sale_target,
    SUM(sale_actual) AS sale_actual,
    CASE WHEN SUM(sale_target) > 0 THEN ROUND(SUM(sale_actual) / SUM(sale_target), 4) ELSE NULL END AS sale_rate,
    SUM(profit_target) AS profit_target,
    SUM(profit_actual) AS profit_actual,
    CASE WHEN SUM(profit_target) > 0 THEN ROUND(SUM(profit_actual) / SUM(profit_target), 4) ELSE NULL END AS profit_rate,
    CASE WHEN SUM(sale_actual) > 0 THEN ROUND(SUM(profit_actual) / SUM(sale_actual), 4) ELSE NULL END AS profit_margin,
    SUM(daily_amount) AS daily_amount,
    SUM(daily_profit) AS daily_profit,
    CASE WHEN SUM(daily_amount) > 0 THEN ROUND(SUM(daily_profit) / SUM(daily_amount), 4) ELSE NULL END AS daily_profit_margin,
    SUM(remaining_daily_profit_target) AS remaining_daily_profit_target
  FROM category_level
  GROUP BY target_id
)`);

  // 7. Final SELECT: UNION ALL category + total
  const finalCols = [
    'target_id', 'category',
    'sale_target', 'sale_actual', 'sale_rate',
    'profit_target', 'profit_actual', 'profit_rate', 'profit_margin',
    'daily_amount', 'daily_profit', 'daily_profit_margin',
    'remaining_daily_profit_target'
  ];

  return `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
WITH ${cteList.join(',\n')}
SELECT ${finalCols.join(', ')} FROM category_level
UNION ALL
SELECT ${finalCols.join(', ')} FROM total_level;`;
}

// ──────────── T6 辅助：final SELECT + 各级 UNION ALL ────────────

/** cost 脱敏（与 tier1 一致；下钻表当前无 cost_sensitive 指标，保留调用点） */
function maskCost(expr: string, m: Metric): string {
  if (!m.cost_sensitive) return expr;
  return `CASE WHEN COALESCE(current_setting('request.jwt.claims.can_see_cost', true)::boolean, false) THEN ${expr} END`;
}

/** 构建最终的 DROP+CREATE VIEW SQL：CTE 链 + 各级 SELECT UNION ALL */
function buildFinalSelect(
  config: ViewConfig,
  metrics: Metric[],
  hierarchy: HierarchyLevel[],
  levelCtes: Map<string, { act: string; tgt: string | null; grain: string[] }>,
  targetLeaves: Metric[],
  cteList: string[],
  view_name: string,
): string {
  const targetLeafCodes = new Set(targetLeaves.map(tl => tl.metric_code));

  // 合并输出维度列集合（按首次出现顺序；照 120 schema 对齐前端期望）
  const unionCols: string[] = [];
  const seenOut = new Set<string>();
  for (const lvl of hierarchy) {
    for (const col of lvl.columns) {
      if (!seenOut.has(col.out)) { seenOut.add(col.out); unionCols.push(col.out); }
    }
  }

  // base/daily metric 在某级 SELECT 中的引用（不含 COALESCE/alias）
  //   target 指标：叶级 leaf_rows 已合并 → a.<code>；父级需 LEFT JOIN tgt → t.<code>；无 tgt → 字面量 0
  //   actual base / daily：act CTE 含 → a.<code>
  // daily 指标（AST filter）+ 叶 base（derived 引用的 base 也要进 cteOf 供 astToSql 解析）
  const dailyCodes = new Set(metrics.filter(m => m.measure_type === 'derived' && m.formula_ast?.t === 'filter').map(m => m.metric_code));
  const leaves = collectLeaves(config.metrics, metrics);


  // 对每级生成一个 SELECT 子查询
  const levelSelects: string[] = [];
  for (const lvl of hierarchy) {
    const info = levelCtes.get(lvl.level);
    if (!info) {
      throw new Error(`generateHierarchyView: levelCtes 缺 level='${lvl.level}'（hierarchy 配置与生成器状态不一致）`);
    }
    const isLeaf = lvl.is_leaf;
    const hasTgt = !!info.tgt;
    const cols: string[] = [];

    // per-level ctx：base actual/daily -> 'a'（act CTE 别名）；target -> isLeaf?'a':(hasTgt?'t':不设)
    const cteOf = new Map<string, string>();
    for (const lf of leaves) {
      if (targetLeafCodes.has(lf.metric_code)) {
        if (isLeaf) cteOf.set(lf.metric_code, 'a');
        else if (hasTgt) cteOf.set(lf.metric_code, 't');
      } else {
        cteOf.set(lf.metric_code, 'a');
      }
    }
    for (const dc of dailyCodes) cteOf.set(dc, 'a');
    // 窗口列（total_days/days_elapsed）在 act CTE 也有（leaf_rows 暴露 / 父级 MAX）-> 引 a. 非 tgt.
    cteOf.set('total_days', 'a');
    cteOf.set('days_elapsed', 'a');
    const ctx: AstCtx = { cteOf, useTargetWindow: true, derivedAst: (code) => metrics.find(m => m.metric_code === code)?.formula_ast ?? undefined, coalesceRefs: true };

    // target_id, level, parent_code
    cols.push('a.target_id');
    cols.push(`'${lvl.level}' AS level`);
    if (lvl.parent_expr) {
      // 叶级引 leaf_rows 暴露列；父级引 act CTE 列（即 grain 元素）
      cols.push(`a.${lvl.parent_expr} AS parent_code`);
    } else {
      cols.push(`NULL::text AS parent_code`);
    }

    // 维度列（合并集合）：该级有的取引用，没有的 NULL::text
    const lvlOuts = new Set(lvl.columns.map(c => c.out));
    for (const ucol of unionCols) {
      const colDef = lvl.columns.find(c => c.out === ucol);
      if (colDef) {
        // 叶级：leaf_rows 用 out 命名列 → 引 a.<out>
        // 父级：act CTE 按 grain 元素命名 → columns.expr 应为 grain 元素 → 引 a.<expr>
        const ref = isLeaf ? `a.${colDef.out}` : `a.${colDef.expr}`;
        cols.push(`${ref} AS ${ucol}`);
      } else {
        cols.push(`NULL::text AS ${ucol}`);
      }
    }

    // 指标列（按 config.metrics 顺序，应用 aliases）
    for (const code of config.metrics) {
      const m = metrics.find(x => x.metric_code === code);
      if (!m) continue;
      const outName = config.aliases?.[code] ?? code;
      let expr: string;
      if (m.measure_type === 'base') {
        // base（含 target）：无 tgt 的 target -> 0
        const ref = cteOf.get(code);
        expr = ref ? `COALESCE(${ref}.${code}, 0)` : '0';
      } else if (dailyCodes.has(code)) {
        expr = `COALESCE(a.${code}, 0)`;  // daily 已在 act CTE 聚合
      } else if (m.formula_ast) {
        expr = derivedExpr(m.formula_ast, ctx);  // rate/remaining/additive -> AST 翻译
      } else {
        expr = 'NULL';
      }
      cols.push(`${maskCost(expr, m)} AS ${outName}`);
    }

    // FROM：叶级 leaf_rows（target 已合并）；父级 <level>_act LEFT JOIN <level>_tgt
    let from: string;
    if (isLeaf) {
      from = `FROM leaf_rows a`;
    } else {
      from = `FROM ${info.act} a`;
      if (hasTgt) {
        const onParts = [`t.target_id = a.target_id`, ...info.grain.map(g => `t.${g} = a.${g}`)];
        from += ` LEFT JOIN ${info.tgt} t ON ${onParts.join(' AND ')}`;
      }
    }

    levelSelects.push(`SELECT\n  ${cols.join(',\n  ')}\n${from}`);
  }

  const finalSelect = levelSelects.join('\nUNION ALL\n');
  return `DROP VIEW IF EXISTS ${view_name};
CREATE VIEW ${view_name} AS
WITH ${cteList.join(',\n')}
${finalSelect};`;
}
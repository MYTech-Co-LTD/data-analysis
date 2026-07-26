#!/usr/bin/env node
/**
 * 语义层视图生成器
 * 读 view-manifest.json + PG(metric_registry/metric_sources/dimension_levels/dimensions)
 * 产出下钻视图迁移（多层 UNION ALL）+ audit 视图（rollup 自校验）
 *
 * 多源支持：base 指标按 source_table 分组（groupSources），每源内层 SUM 该源指标/其它 0，
 * UNION ALL 后外层合总；derived additive 跨源合计；virtual_nodes 标记虚拟节点（不 JOIN dim_branch）。
 * 比率 derived（margin）仅单源无虚拟节点视图支持（多源/含虚拟节点 → 报错）。
 *
 * 用法：DATABASE_URL=postgresql://postgres:postgres@localhost:5432/insforge node scripts/generate-views.js
 */
const fs = require("fs");
const path = require("path");
const { Client } = require(path.join(__dirname, "..", "services", "node_modules", "pg"));

const MANIFEST_PATH = path.join(__dirname, "view-manifest.json");
const MIGRATIONS_DIR = path.join(__dirname, "..", "database", "migrations");

function nextMigrationNum() {
  const nums = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => parseInt(f.slice(0, 3), 10));
  return (nums.length ? Math.max(...nums) : 0) + 1;
}

async function readModel(client) {
  const [metrics, sources, levels, dims] = await Promise.all([
    client.query(
      "SELECT metric_code, measure_type, formula, depends_on, additive, cost_sensitive FROM metric_registry WHERE enabled"
    ),
    client.query("SELECT metric_code, source_table, source_column, source_filter FROM metric_sources"),
    client.query(
      "SELECT dim_code, level_code, depth, key_column, name_column, parent_level FROM dimension_levels ORDER BY dim_code, depth"
    ),
    client.query("SELECT dim_code, join_table, join_key, is_assessed_filter FROM dimensions WHERE enabled"),
  ]);
  return { metrics: metrics.rows, sources: sources.rows, levels: levels.rows, dims: dims.rows };
}

// pg JSONB 通常直接返回 JS 数组；兼容历史字串
function normDeps(d) {
  if (Array.isArray(d)) return d;
  if (typeof d === "string") {
    try {
      return JSON.parse(d);
    } catch {
      return [];
    }
  }
  return [];
}

// 多源分组：base 指标按 (source_table, source_filter) 分组（同表不同 filter 视为不同源；
// 例如 wholesale_pp sbc=64188 vs wholesale_ext sbc=3120 须分离，否则虚拟节点合并不分）
// 单源视图（同表同 filter）退化为 1 组
function groupSources(view, model) {
  const baseMetrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  if (baseMetrics.length === 0) throw new Error(`视图 ${view.name}: 无 base 指标，无法定位 source_table`);
  const map = new Map();
  for (const m of baseMetrics) {
    const s = model.sources.find((x) => x.metric_code === m.metric_code);
    if (!s) throw new Error(`指标 ${m.metric_code} 无 metric_sources 映射`);
    const key = `${s.source_table}||${s.source_filter || ""}`;
    if (!map.has(key)) map.set(key, { table: s.source_table, filter: s.source_filter, metrics: [] });
    map.get(key).metrics.push({ metric_code: m.metric_code, source_column: s.source_column });
  }
  return [...map.values()];
}

// 生成单层 UNION 分支（多源：每源内层 SUM 该源指标/其它 0 → UNION ALL → 外层合总 + derived 跨源合计）
function genLevelBranch(view, level, parentLevel, groups, model, dim) {
  const virtualNodes = view.virtual_nodes || {};
  const allBase = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "base");
  const derivedAdd = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && m.additive);
  // 比率 derived（margin）：多源/含虚拟节点视图不支持；仅单源无虚拟节点视图允许（口径：SUM(num)/NULLIF(SUM(den),0)）
  const derivedRatio = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && m.measure_type === "derived" && !m.additive);
  const isMultiOrVirtual = groups.length > 1 || Object.keys(virtualNodes).length > 0;
  if (isMultiOrVirtual && derivedRatio.length) throw new Error(`视图 ${view.name}: 多源/含虚拟节点视图不支持比率 derived [${derivedRatio.map((d) => d.metric_code).join(",")}]（margin 仅用于同源 sale 视图）`);

  const tgtExpr = view.target_scoped ? `t.id` : `NULL::bigint`;

  // 每源内层 SELECT
  const inners = groups.map((grp) => {
    const grpCodes = grp.metrics.map((g) => g.metric_code);
    const isVirtual = grpCodes.some((c) => virtualNodes[c]);
    const vname = isVirtual ? virtualNodes[grpCodes.find((c) => virtualNodes[c])] : null;
    const codeExpr = isVirtual ? `'${vname}'` : `dim.${level.key_column}`;
    const nameExpr = isVirtual ? `'${vname}'` : `dim.${level.name_column}`;
    const parentExpr = isVirtual ? `NULL::text` : parentLevel ? `dim.${parentLevel.key_column}` : `NULL::text`;
    const baseCols = allBase.map((b) => {
      const inGrp = grp.metrics.find((g) => g.metric_code === b.metric_code);
      return inGrp ? `SUM(s.${inGrp.source_column}) AS ${b.metric_code}` : `0 AS ${b.metric_code}`;
    });
    let from = `    FROM ${grp.table} s`;
    if (!isVirtual) from += `\n    JOIN ${dim.join_table} dim ON s.branch_num = dim.${dim.join_key} AND s.system_book_code = dim.system_book_code`;
    if (view.target_scoped) from += `\n    JOIN targets t ON (t.system_book_code = 'ALL' OR s.system_book_code = t.system_book_code)\n      AND s.biz_date BETWEEN t.start_date AND t.end_date`;
    const where = [];
    if (view.target_scoped) where.push("t.status = 'active'");
    if (grp.filter) where.push(grp.filter);
    if (view.assessed_filter && !isVirtual) where.push("is_assessed_war_zone(dim.first_level_region)");
    const groupCols = [];
    if (view.target_scoped) groupCols.push("t.id");
    if (!isVirtual && parentLevel) groupCols.push(`dim.${parentLevel.key_column}`);
    if (!isVirtual) { groupCols.push(`dim.${level.key_column}`); groupCols.push(`dim.${level.name_column}`); }
    const groupTail = groupCols.length ? `\n    GROUP BY ${groupCols.join(", ")}` : "";
    return `    SELECT '${level.level_code}' AS level, ${parentExpr} AS parent_code, ${tgtExpr} AS target_id, ${codeExpr} AS code, ${nameExpr} AS name, ${baseCols.join(", ")}\n${from}\n${where.length ? "    WHERE " + where.join(" AND ") : ""}${groupTail}`;
  });

  // 外层合总 + derived 跨源合计
  for (const d of derivedAdd) {
    const deps = normDeps(d.depends_on);
    for (const dep of deps) if (!allBase.some((b) => b.metric_code === dep)) throw new Error(`视图 ${view.name}: derived ${d.metric_code} 依赖 ${dep} 未声明为 base`);
  }
  const outerBase = allBase.map((b) => `SUM(${b.metric_code}) AS ${b.metric_code}`);
  const outerDerived = derivedAdd.map((d) => {
    const deps = normDeps(d.depends_on);
    return `(${deps.map((dep) => `SUM(${dep})`).join(" + ")}) AS ${d.metric_code}`;
  });
  // 单源 + 无虚拟节点：比率 derived 在外层用 SUM(num)/NULLIF(SUM(den),0) 重算（与原单源生成器口径等价）
  const outerRatio = !isMultiOrVirtual ? derivedRatio.map((d) => {
    const deps = normDeps(d.depends_on);
    if (deps.length !== 2) throw new Error(`视图 ${view.name}: 比率 derived ${d.metric_code} depends_on=[${deps.join(",")}]，生成器仅支持二元比率`);
    for (const dep of deps) if (!allBase.some((b) => b.metric_code === dep)) throw new Error(`视图 ${view.name}: 比率 derived ${d.metric_code} 依赖 ${dep} 未声明为 base`);
    const [numCode, denCode] = deps;
    return `(SUM(${numCode}) / NULLIF(SUM(${denCode}), 0)) AS ${d.metric_code}`;
  }) : [];
  const outerCols = [...outerBase, ...outerDerived, ...outerRatio];
  const groupOuter = ["level", "parent_code", ...(view.target_scoped ? ["target_id"] : []), "code", "name"];
  return `  SELECT level, parent_code, ${view.target_scoped ? "target_id, " : ""}code, name, ${outerCols.join(", ")}\n  FROM (\n${inners.join("\n  UNION ALL\n")}\n  ) combined\n  GROUP BY ${groupOuter.join(", ")}`;
}

// audit：遍历 view 所有可加指标（base + derived additive），各层合总一致性（diff vs 第 0 层）
function genAuditSql(viewName, view, levels, model) {
  const auditName = viewName + "_audit";
  const codes = levels.map((l) => l.level_code);
  const tgt = view.target_scoped;
  const metrics = view.metrics
    .map((c) => model.metrics.find((m) => m.metric_code === c))
    .filter((m) => m && (m.measure_type === "base" || (m.measure_type === "derived" && m.additive)));
  const pivots = [];
  const diffs = [];
  const outCols = [];
  if (tgt) outCols.push("target_id");
  for (const mc of metrics) {
    for (const c of codes) pivots.push(`MAX(CASE WHEN level='${c}' THEN ${mc.metric_code}_sum END) AS ${mc.metric_code}_${c}_total`);
    outCols.push(...codes.map((c) => `${mc.metric_code}_${c}_total`));
    for (let i = 1; i < codes.length; i++) { diffs.push(`ABS(${mc.metric_code}_${codes[0]}_total - ${mc.metric_code}_${codes[i]}_total) AS ${mc.metric_code}_${codes[0]}_vs_${codes[i]}_diff`); outCols.push(`${mc.metric_code}_${codes[0]}_vs_${codes[i]}_diff`); }
  }
  const innerSums = metrics.map((mc) => `SUM(${mc.metric_code}) AS ${mc.metric_code}_sum`).join(", ");
  return `DROP VIEW IF EXISTS ${auditName};
CREATE VIEW ${auditName} AS
  SELECT
    ${outCols.join(",\n    ")}
  FROM (
    SELECT${tgt ? "\n      target_id," : ""}
        ${pivots.join(",\n        ")}
    FROM (
      SELECT${tgt ? " target_id," : ""} level, ${innerSums}
      FROM ${viewName}
      GROUP BY ${tgt ? "target_id, " : ""}level
    ) y
    GROUP BY${tgt ? " target_id" : ""}
  ) z;
ALTER VIEW ${auditName} SET (security_invoker = true);
GRANT SELECT ON ${auditName} TO authenticated, anon;`;
}

function genViewSql(view, model) {
  const dim = model.dims.find((d) => d.dim_code === view.dimension);
  if (!dim) throw new Error(`维度 ${view.dimension} 未注册`);
  const groups = groupSources(view, model);
  const levels = model.levels
    .filter((l) => l.dim_code === view.dimension && view.levels.includes(l.level_code))
    .sort((a, b) => a.depth - b.depth);
  if (levels.length === 0) throw new Error(`维度 ${view.dimension} 无匹配层级 ${view.levels}`);
  const branches = levels.map((lvl) => {
    const parent = lvl.parent_level ? levels.find((l) => l.level_code === lvl.parent_level) : null;
    return genLevelBranch(view, lvl, parent, groups, model, dim);
  });
  const viewName = `report_${view.name}_v`;
  let sql = `-- AUTO-GENERATED by scripts/generate-views.js（勿手改；改 view-manifest.json 后重生成）\n-- 幂等：DROP VIEW IF EXISTS + CREATE VIEW；部署后重启 postgrest\n\n`;
  sql += `DROP VIEW IF EXISTS ${viewName} CASCADE;\nCREATE VIEW ${viewName} AS\n${branches.join("\nUNION ALL\n")};\n`;
  sql += `ALTER VIEW ${viewName} OWNER TO postgres;\nALTER VIEW ${viewName} SET (security_invoker = true);\nGRANT SELECT ON ${viewName} TO authenticated, anon;\n`;
  if (view.audit) sql += "\n" + genAuditSql(viewName, view, levels, model) + "\n";
  return sql;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const conn = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/insforge";
  const client = new Client({ connectionString: conn });
  await client.connect();
  const model = await readModel(client);
  await client.end();

  let nextNum = null;
  for (const view of manifest.views) {
    const sql = genViewSql(view, model);
    // 重生成时覆盖同名 generated 文件（保持编号）；无则新建
    const existing = fs
      .readdirSync(MIGRATIONS_DIR)
      .find((f) => f.endsWith(`_generated_${view.name}.sql`));
    let fname;
    if (existing) {
      fname = existing;
    } else {
      if (nextNum === null) nextNum = nextMigrationNum();
      fname = `${String(nextNum).padStart(3, "0")}_generated_${view.name}.sql`;
      nextNum++;
    }
    fs.writeFileSync(path.join(MIGRATIONS_DIR, fname), sql);
    console.log(`✓ ${existing ? "updated" : "generated"} database/migrations/${fname}`);
  }
}

main().catch((e) => {
  console.error("生成失败:", e.message);
  process.exit(1);
});
